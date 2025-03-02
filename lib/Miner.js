/******************************************
 * Mining Class
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * 
 * MIT License
 * 
 * Instantiate with, for example:
 *    nodeName (miner), host (localhost), port (5000), dataPath (./data):
 * 
 * const miner = new Miner({ nodeName, host, port, nodes, dataPath })
 * 
 * It will start a worker thread, and then try to reload all existing blocks
 * - mining timer will check every 10s on status or if pending transactions to work with
 * - heartbeat timer will send out ping to known peers, and process their responses
 * 
 * PUBLIC METHODS
 * Abstraction-wise, ONLY methods dealing at the level of the node are here, blockchain-associated 
 * ones are pushed down to that class, ledger-based ones in the ledger class.
 * 
 * Unconfirmed/pending transactions are dealt with in the node as they are relevant to it's
 * operations in deciding blocks to mine, and what info to communicate to other nodes.
 */

import path from 'path'
import Blockchain from './Blockchain.js'
import Ledger from './Ledger.js'
import { Worker } from 'worker_threads'
import { urlCall, sha256Hash, fixRounding, time, waitReady, debug } from './helper.js'

const MINING_TIMEOUT = 7200                 // if mining hanging, reset to READY after this time
const MINE_INTERVAL = 10                    // how often to check updates from worker thread and queue work
const HEARTBEAT_INTERVAL = 30               // how often to announce heartbeat, check blockchain height
const NODE_TIMESTAMP_TOLERANCE = 1800       // how much can a node be different than our time before ignoring it
const MAX_PENDING_PER_USER = 16             // prevent user-spamming transactions, limit how many we accept in our pending list
const PENDING_TRANSACTION_STALE = 300       // time after which we flush pending as stale

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, hosts, dataPath }) {
        debug( 'cyan', `\n\n**MINER** Created nodeName(${nodeName} @ ${host}:${port}) hosts(${hosts})`
              +`\n=========================================================================================` )
        this.version = '0:1.0'              // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.nodeState = 'LOADING'          // LOADING, ONLINE, REBUILDING, OFFLINE
        this.startTime = time()
        this.hostname = `http://${host}:${port}`
        this.peers = {}
        this.pendingTransactions = []       // mempool transactions want to put into an upcoming block
        this.dataPath = dataPath
        this.worker = { 
            node: null,
            status: 'IDLE',
            startTime: 0,
            timeout: MINING_TIMEOUT,
            block: null
        }

        // add hardcoded known peers, including self
        hosts.push(this.hostname)
        this.addPeerHosts( hosts )

        // the address wallets, create wallet, reset balances (re-established as blockchain built)
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        this.ledger.createWallet(nodeName)
        this.ledger.reset()

        // init blockchain
        debug('dim')
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, dataPath })
        debug('reset')

        // BUGBUG remove 
        debug('bold', 
             `\n\n== MINER ==========================================================`
            +`\n${this.nodeName} Address:\n${this.ledger.getPublicKey(this.nodeName)}`
            +`\nBlock Height: ${this.blockchain.height()}`
            +`\n== LEDGER =========================================================`)
        this.ledger.walletBalances()
        debug(`\n\n\n`)

        // Start mining Worker thread
        this.startMinerThread()
        // Run periodic mining attempt (that offloads task to worker)
        this.startMining()

        // everything worked, our node should now be online able to respond to queries
        this.nodeState = 'ONLINE'

        // Announce node to known hosts
        this.broadcastPeers({ path: '/node/announce', data: this.pingInfo(this.blockchain.height()-1) })
            .then( response => this.pingResponseProcess(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
    }

    startMinerThread(){
        this.worker.node = new Worker(path.resolve('./lib', 'MinerWorker.js'))
        this.worker.node.on('message', ({ action, ...result }) => {
            switch( action ){
                case 'UPDATE':
                    debug('dim',`  ~ [Miner] Worker update (nonce=${result.nonce}, elapsed=${result.elapsed}s)`)
                    break
                case 'ABORT':
                    debug('dim',`  ~ [Miner] Worker notified aborted; elapsed=${result.elapsed}s. Ready again.`)
                    this.worker.status = 'CLEANUP'
                    break
                case 'UNSOLVED':
                    debug('dim',`  ~ [Miner] Worker notified going to abort, couldn't find match in nonse-range (elapsed=${result.elapsed}s)`)
                    this.worker.status = 'CLEANUP'
                    break    
                case 'SOLVED':
                    this.worker.block = result.block
                    if( this.worker.status === 'MINING_PAUSE' )
                        this.worker.status = 'SOLVED_PAUSE'
                    else
                        this.worker.status = 'SOLVED'
                    break
                default:
                    break
            }
        })
      
        this.worker.node.on('error', (error) => {
            debug('red', '  ~ [Miner] Worker ERROR:', error)
        })
    
        this.worker.node.on('exit', (code) => {
            debug('red', `  ~ [Miner] Worker DIED with exit code ${code}`); // code 0 = normal
        })
    }

    addPeerHosts( hosts ){
        let newHosts = []
        hosts.forEach( host => {
            if( this.peers[host] === undefined ){
                debug( 'cyan', `   + NEW peer: ${host}`)
                this.peers[host] = { hostname: host, nodeName: '', dir: 'out', pingError: 0 }
                newHosts.push(host)
            }
        })
        return newHosts
    }

    heartbeat(){
        // real BTC server: send heartbeach every 30mins, if none after 90, assume client connection closed
        // us: send every 30s, 120s assume gone
        setInterval(async () => {
            // if( _heartbeat_peers ) console.log( `[heartbeat] (${this.peers.map(peer => peer.hostname).join(',')})`)
            const peers = Object.values(this.peers).map( node => node.hostname )
            if (peers.length > 0) {
                this.broadcastPeers({ path: '/node/announce', hosts: peers, data: this.pingInfo() })
                    .then( response => this.pingResponseProcess(response) )

                // check if any have a longer blockchain, and grab those new blocks!
                this.nodeState = 'LOADING'
                const syncResult = this.syncMissingBlocks()
                if( syncResult.error ) debug( 'red', syncResult.error )
                this.nodeState = 'ONLINE'
        
                // clear out stale pendingTransactions
                this.pendingTransactions.filter( t => t.timestamp < (time() - PENDING_TRANSACTION_STALE) ).forEach( t => {
                    debug('cyan',`   ~ Clearing stale pending transactions: ${t.src.split(':')[0]}/${t.seq} > ${t.dest.split(':')[0]} $${t.amount} Staked(${t.txStake})`)
                    this.transactionReverse(t, {clearPending: true})
                })
            }
        }, HEARTBEAT_INTERVAL * 1000)
    }

    pingInfo( queryBlockIndex=this.blockchain.height()-1 ){
        // a node/announce includes key info about this node, including timestamp and who it knows, and block length
        // they send all their peers, if you block not latest, they will send up to 500 blocks ahead of it (then you process and request more)
        const response = {
            nodeName: this.nodeName,
            version: this.version,
            nodeState: this.nodeState,
            hostname: this.hostname,
            type: this.type,
            startTime: this.startTime,
            timestamp: time(),
            peers: Object.keys(this.peers), // only pass on hostname
            pendingTransactionsCnt: this.pendingTransactions.length,
            blockchainHeight: this.blockchain.height(),
            blockAtHeight: {}
        }

        // if info is response to another node, they specified their block-height,
        // we specify our hash/timestamp for that height-block
        if( queryBlockIndex < this.blockchain.height() )
            response.blockAtHeight = { index: this.blockchain.getBlock(queryBlockIndex).index, 
                                       hash: this.blockchain.getBlock(queryBlockIndex).hash, 
                                       timestamp: this.blockchain.getBlock(queryBlockIndex).timestamp }
        
        return response
    }

    pingResponseProcess( response ){
        if( response.error || response.result.length<1 )
            return { error: response.error || false} // nothing to process, maybe no nodes

        // review each response, add to peers table
        for( let node of response.result ){
            if( node.error ){
                const peer = this.peers[node.hostname]
                if( peer )
                    peer.pingError = (peer.pingError || 0) + 1
                // peer.pingNext = time() + peer.pingError * HEARTBEAT_INTERVAL // each error, spaces out next outreach attempt
            } else {
                // gather all self-reporting data from peer into peers object
                delete node.error
                delete node.peers
                this.peers[node.hostname] = { ...this.peers[node.hostname], ...node, pingError: 0 } // ...this.peers[peerIdx],
            }
        }
    }

    // scan through peers and see if we should ask for blocks from anyone
    async syncMissingBlocks(){
        const peers = Object.values(this.peers)
        if( peers.length<1 )
            return { error: `No nodes to connect with. Aborting.`}

        // fill OUR details in peers structure for comparison
        const latestBlock = this.blockchain.getBlock()
        this.peers[this.hostname].blockchainHeight = this.blockchain.height()
        this.peers[this.hostname].blockAtHeight = latestBlock

        // PICK peer with LONGEST CHAIN; if same as us, one with OLDEST timestamp
        let selNode = peers.reduce((sel, item) => item.blockchainHeight >= sel.blockchainHeight ? item : sel)
        if( selNode.blockchainHeight === this.blockchain.height() && selNode.blockAtHeight.index === latestBlock.index ) 
            selNode = peers.reduce((sel, item) => item.blockchainHeight === sel.blockchainHeight && 
                                                  item.blockAtHeight.timestamp < sel.blockAtHeight.timestamp ? item : sel)

        if( !selNode?.nodeName || selNode.blockchainHeight < this.blockchain.height() || selNode.blockAtHeight.index < latestBlock.index || 
            (selNode.blockchainHeight === this.blockchain.height() && selNode.blockAtHeight.timestamp >= latestBlock.timestamp ) ){
            // there is no node with longer chain or same-height & older timestamp or there's a problem with selNode so don't proceed
            return { error: false, addBlockCnt: 0, transactionCnt: 0 }
        }

        // A BETTER chain exists - let's find from whence we shall sync and redo ours.
        debug( 'bold', ` x US (${this.nodeName}) vs THEM (${selNode.nodeName}): blocks(${this.blockchain.height()} vs ${selNode.blockchainHeight}) timestamp(${latestBlock.timestamp} vs ${selNode.blockAtHeight?.timestamp || 'n/a'}) (ours: #${latestBlock.index}/${latestBlock.timestamp}, theirs: #${selNode.blockAtHeight?.index || 'n/a'}/${selNode.blockAtHeight?.timestamp || 'n/a'}, finding last common node, and overwriting rest` )

        // request last 100 hashes [arbitrary choice] and we'll try to find last matching block
        const fromIndex = Math.max(0, this.blockchain.height()-100 )
        const response = await urlCall({ hostname: selNode.hostname, path: `/blocks/hashes?fromIndex=${fromIndex}`, nodeToken: this.nodeName })
        if( response.error ) return response

        // now work our back way to find highest matching block
        let index = latestBlock.index
        for( let i=this.blockchain.height()-1; i >= fromIndex; i-- ){
            if( !response.result[i-fromIndex] ) return { error: `Invalid /blocks/hashes result: `, result }

            if( this.blockchain.getBlock(i).hash === response.result[i-fromIndex].hash ){
                index = i
                debug('bold', ` ~ found MATCH @ #${i}, syncing from there.`)
                break
            }
        }

        debug('cyan',` > [${selNode.nodeName}] chain matches mine to #(${index}), getting remainder and overwriting ours (/blocks?fromIndex=${index+1})... `)
        let addResult
        try {
            // since we aren't longest, nodeState should not be ONLINE, as we attempt to sync-up
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks?fromIndex=${index+1}`, nodeToken: this.nodeName })
            if( response.error ) return response

            // add these new blocks, first write them, then sync transactions
            const newBlocks = response.result
            debug('dim',`  + got blocks to add: ` + newBlocks.map( b => b.index ).join(',') )
            addResult = this.blockchain.addBlockchain(newBlocks, { forceOverwrite: true, txUpdate: true })
            if( addResult.error ) return addResult
            // if any of these are in pending, remove them
            const foundHashes = this.prunePendingTransactions( addResult.hashes )
            debug('dim',`  >>> added ${addResult.addBlockCnt} blocks containing ${addResult.transactionCnt} transactions; pruned pending transactions`, foundHashes )
            if( addResult.resetLedger ){
                debug('green', "Note: our pendingTransactions may not be properly reflected as ledger was wiped and rebuilt; but when blocks created, they will reflect properly.")
                // we reset the ledger, so now add back any pending
                // for( const t of this.pendingTransactions ){
                //     const { txStake, balance, ...transaction }= t
                //     const result = this.ledger.transaction(transaction) 
                //     if( result.error ) debug('red', `After resetLedger, problem re-adding pending transaction: ${result.error}`)
                // }                    
            }
            return { error: false, foundHashes }

        } catch (e) {
            debug('red',`     ! Error with peer: ${e.message}`)
            return { error: e.message }
        }
    }

    async broadcastPeers({ path, data = '', hosts }) {
        let broadcastPeers
        if( hosts === undefined || hosts.length < 1 ) // no hosts specified? >> blast everyone with transaction
            broadcastPeers = Object.keys(this.peers).filter( host => host !== this.hostname )
        else
            broadcastPeers = hosts.filter( host => host !== this.hostname ) //.filter( host => this.peers[host]?.dir === 'out' ) // only one ping direction

        // BUGBUG debug only block
        if( broadcastPeers.length>0 ){
            const color = path.includes('/node/announce') ? 'dim' : 'cyan'
            const pending = path.includes('/node/announce') ? ` pendingTransactions(${this.pendingTransactions.length})` : ''
            debug(color, `<< [${this.nodeName}]${path} [${this.nodeState}]${pending} @ (${broadcastPeers.join(',').replaceAll('http://localhost:','')})` )
        }

        const requests = broadcastPeers.map(async (host, idx) => {
            // the 'node'
            const request = { hostname: host, path, nodeToken: this.nodeName }
            if (data) request.body = data

            // try {
            const response = await urlCall(request)
            response.hostname = request.hostname
            if( response.error ){
                debug('dim',`   ! urlCall error: ${response.error}`)
                return response
            }

            // only deal with servers that are within 30 minutes of us
            if( Math.abs(response.timestamp - time()) > NODE_TIMESTAMP_TOLERANCE )
                return { ...response, error: 'Peers time unavailable of way off, ignoring!' }

            // in our peers object, track some stuff from the responding peer
            for( const key of ['nodeName','version','nodeState','type','startTime','timestamp','pendingTransactionsCnt','blockchainHeight'] )
                if( response[key] ) this.peers[host][key] = response[key]

            // if they have peers, let's add them & announce ourselves
            if( response.peers ){
                const newHosts = this.addPeerHosts( response.peers )
                if( newHosts.length > 0 )
                    this.broadcastPeers({ path: '/node/announce', hosts: newHosts, data: this.pingInfo(this.blockchain.height()-1) })
                        .then( response => this.pingResponseProcess(response) )
            }
            return response
            // } catch(e) {
            //     debug('red',`   - Failed to connect host: ${request.hostname}`)
            //     return { error: `broadcast error; failed to connect ${request.hostname}` }
            // }

        })
        const result = (await Promise.all(requests)).filter(res => res !== null)
        return { error: false, result }
    }

    transactionFee({ amount, fee=0 }){
        // transaction occurs in Ledger, but we contribute the fee our miner charges here
        // users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        //  miner can override upward the fee
        if( fee<0 ) fee = 0
        fee = fixRounding( Math.max(fee, Number(amount || 0) * this.blockchain.transactionFee) )
        if( this.blockchain.transactionFeeMax > 0 )
            fee = Math.min(this.blockchain.transactionFeeMax, fee)
        return fee
    }
    
    // prepare a transaction for miner (so adjust pendingTransactions layer too)
    transaction({src, dest, amount, fee = 0, seq = 0, txSig = '', hash = '', ...data}, blockIdx) {
        // Validate transaction
        if (!src || !dest || !amount) {
            debug('red',`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            return { error: `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` }
        }

        // managing stats in the src wallet
        const srcWallet =  this.ledger.getWallet(src)
        if( srcWallet.error ) return srcWallet // error return it

        if( src.startsWith('_') ){
            // _admins don't pay fees in our blockchain (& no sequential tracking)
            fee = 0
        } else {
            // verify their transaction sequence is ok - MUST be sequential+1
            if( Number(seq) !== Number(srcWallet.tx.seq) + 1 ){
                debug('red',`Invalid src sequence (seq=${seq}), expected ${srcWallet.tx.seq+1}` )
                return { error: `Invalid src sequence (seq=${seq}), expected ${srcWallet.tx.seq+1}`, seq: srcWallet.tx.seq+1 }
            }

            // verify there are excess pending from this src, reject it
            const transSrc = this.ledger.buildTransactionName(src, srcWallet.publicKey)
            const pendingSrcCnt = this.pendingTransactions.filter( t => t.src === transSrc ).length
            if( pendingSrcCnt > MAX_PENDING_PER_USER ) {
                return { error: `Sorry too many transactions (${pendingSrcCnt}) by user (${src}). Please resubmit later once blocks mined.` }
            }
            fee = this.transactionFee({ amount, fee })
        }

        // issue a stake request as it came through us
        const txStake = `${this.nodeName}:${time()}`
        const newTransaction = this.blockchain.transaction({src, dest, amount, fee, seq, txSig, hash, ...data, txStake}, blockIdx)

        // put into pending transactions (if no error)
        if( !newTransaction.error )
            this.pendingTransactions.push( newTransaction )

        return { ...newTransaction, balance: srcWallet.tx.balance  }
    }

    // 2 modes of use:
    // no 'clearPending': will uncommit pending from a block OR revert transaction if no pending
    // with clearPending: fully nuke transaction regardless, pending included
    transactionReverse({hash, ...data}, options = {}) {
        const { blockIdx = -1, clearPending = false } = options
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}
        
        // if it has a pending, we revert to that, else we actually erase
        // debug( 'dim', `[transactionReverse] hash(${hash})`)
        const pendingIdx = this.pendingTransactions.findIndex( t => t.hash === hash )
        if( clearPending ){
            delete this.blockchain.transactionHashes[hash]
            if( pendingIdx > -1 ) this.pendingTransactions.splice(pendingIdx,1)

            const result = this.blockchain.transactionReverse({hash, ...data}, options)
            return result

        } else {
            if( pendingIdx > -1 ){
                debug('dim',` \.. found pending, resetting transactionHash: -1`)
                if( this.blockchain.transactionHashes[hash] !== undefined )
                    this.blockchain.transactionHashes[hash].index = -1
                return { error: false, hash, transHashCleared: this.blockchain.transactionHashes[hash] !== undefined }
            } else {
                // debug('dim',` \.. no pending, fully reversing it`)
                const result = this.blockchain.transactionReverse({hash, ...data}, options)
                return result
            }
        }
    }

    prunePendingTransactions( hashes ){
        if( !hashes || hashes.length<1 ) return ''

        // BUGBUG this block is just debug
        const foundHashes = this.pendingTransactions.filter( pT => hashes.includes(pT.hash) ).map( t => t.hash ).join(',')
        if( foundHashes ) debug('dim',`   x removing pendingTransaction(${foundHashes})`)

        // remove from pendingTransactions (if there)
        this.pendingTransactions = this.pendingTransactions.filter( pT => !hashes.includes(pT.hash) )
        return foundHashes
    }


    // mining state machine
    startMining() {
        let mineTransactions = []
        let rewardTransactions = []
        let onChainSeq = {} // create a temp 'onChain' reference
        this.worker.status = 'READY'
        
        const workerMinePending = () => {
        switch( this.worker.status ){
            case 'READY': {
                mineTransactions = []
                rewardTransactions = []
                onChainSeq = {}
                const calc = this.blockchain.calcMiningReward(this.blockchain.height())
                this.blockchain.miningReward = calc.miningReward
                this.blockchain.difficulty = calc.difficulty

                // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
                // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
                //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)

                // issue..airdrop..deposit FIRST (as affect src liquidity), then other movements, and LAST miningFees and finally miningReward
                // technically miningFees/miningReward should NEVER be in transactions, as they are added at the time blocks are minted
                const typeOrder = { mintIssue: 0, mintAirDrop: 1, minerDeposit: 2, /* others: 3 */ miningFees: 9, miningReward: 10 }

                mineTransactions = this.pendingTransactions
                    .filter(t => t.txStake.startsWith(this.nodeName + ':'))     // select only transactions staked by us
                    .filter(t => t.timestamp < (time()-30))                     // give at least 30s for concensus before mining (*assumes same server or ntp sync)
                    .slice()                                                    // creates-clone, so sort() will work on it (Node20+: toSorted())
                    .sort((a, b) => (
                        ((typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3)) ||
                        (a.timestamp - b.timestamp) ||
                        a.src.localeCompare(b.src) ||
                        (a.seq - b.seq)
                    ))
                // now pick out VALID chronological SEQ entries (relative to src onChain) --> else delay / expire them
                mineTransactions = mineTransactions.filter((t) => {
                        const src = t.src
                        const seq = Number(t.seq)
                        if (!src.startsWith('_')) {
                            if (!onChainSeq[src]) {
                                const srcWallet = this.ledger.getWallet(src)
                                onChainSeq[src] = srcWallet.onChain.seq
                            }
                            const nextSeq = Number(onChainSeq[src]) + 1
                            if (seq === nextSeq) {
                                debug('green',`*** Queued for mining: ${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}  - onChainSeq[src](${onChainSeq[src]}) srcWallet.tx.seq(${this.ledger.getWallet(src).tx.seq})`)
                                onChainSeq[src]++

                            } else if(seq > nextSeq) {
                                debug('dim',`    ~~ delaying mining ${t.txStake?.split(':')[0] || ''} transaction ${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}: onChainSeq(${onChainSeq[src]}) as its not chronological`)
                                return false

                            } else if(seq < nextSeq) {
                                // if the pending transaction is OLDER than the current block seq, that means there must have been duplicate (node spammed?), cancel these.
                                debug('cyan',`    xx removing transaction ${src.split(':')[0]}/${seq} older than onChainSeq(${onChainSeq[src]}), will never be minted, so kill it! `)
                                // this.broadcastPeers({ path: '/transactions/expired', data: [t] })
                                const result = this.transactionReverse( t, { clearPending:true })
                                // if( result.error ) debug('red', result.error)
                                return false
                            }
                        }
                        return true
                    })
                    .slice(0, this.blockchain.transactionsPerBlock.max)
                    
                // min limit per block, have a kitkat, take a break!
                if( mineTransactions.length < this.blockchain.transactionsPerBlock.min ) break
                
                debug('cyan',`*** MINING START (${this.nodeName}) *** (difficulty: ${this.blockchain.difficulty}) reward=${this.blockchain.miningReward}`)
                debug('dim')
                mineTransactions.forEach( t => {
                    // indicate we are mining in the metadata -> in this.pendingTransactions
                    t.txStake += ' MINING:' + time()
                    if( t.fee>0 ) 
                        rewardTransactions.push( this.blockchain.transaction(
                        { src: '_mint', dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash } ) )
                })

                // block mining reward
                if( this.blockchain.miningReward>0 )
                    rewardTransactions.push( this.blockchain.transaction(
                    { src: '_mint', dest: this.nodeName, amount: this.blockchain.miningReward, type: 'miningReward' }))

                // problems setting up rewardTransactions? ABORT!
                if( rewardTransactions.filter( t => t.error ).length > 0 ){
                    debug('dim',` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
                    this.worker.status = 'CLEANUP'
                    break
                }

                // remove miner meta-data (ex. txStake); append reward transactions -> transaction block
                mineTransactions = [ ...mineTransactions.map( ({txStake, balance, ...data }) => data ), ...rewardTransactions ]
console.log( 'miing transactions: ', mineTransactions )
                // no errors, great build markleTree and add block
                if( mineTransactions.length === 0 ){
                    debug('red',`ERROR, strange error, initially had mineTransactions, but then after adding rewards, removing meta, we have none?! Should never happen!` )
                    break
                }

                const [ merkleRoot ]= this.blockchain.merkleBuild( mineTransactions ).pop()

                const blockData = {
                    merkleRoot,
                    transactions: mineTransactions
                }
                // Construct the block that we'll ATTEMPT to mine
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const newBlock = this.blockchain.addBlock(blockData, { prepareOnly: true })
                if( newBlock.error ){
                    debug('dim',` ~ [Miner] addBlock failed with transaction ${newBlock.transaction.hash}, dropping it before re-attempting to mine.`)
                    if( newBlock.transaction.hash ) // failed due to this transaction, so we will drop it and try again
                        this.prunePendingTransactions([ newBlock.transaction.hash ])                    
                    this.worker.status = 'CLEANUP'
                    break
                }

                // offload to worker thread to solve (keeps system responsive)
                this.worker.status = 'MINING'
                this.worker.startTime = time()
                this.worker.block = { index: blockData.index }
                this.worker.node.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.blockchain.difficulty})
                break
                }
            case 'MINING':
            case 'MINING_PAUSE':
            case 'SOLVED_PAUSE': {
                // Check for mining timeout
                const elapsed = time() - this.worker.startTime
                if (elapsed > this.worker.timeout) {
                    debug('green',` ! Mining timeout after ${elapsed}s. Aborting.`)
                    this.worker.node.postMessage({action: 'ABORT'})
                } else {
                    debug('dim',` ~ [Miner] checking in (${this.worker.status}), worker still mining (${elapsed}s elapsed)`)
                }
                break
                }
            case 'SOLVED': {
                // Worker thread should have solved, now 'this.workerBlock' has a full solution nonce
                this.nodeState = 'LOADING'
                const addResult = this.blockchain.addBlockchain([this.worker.block])
                if( addResult.error ){
                    this.worker.status = 'CLEANUP'
                    break
                }
                this.nodeState = 'ONLINE'
                const block = addResult.blocks[0]
                const { hashes, newHashes, transactionCnt, resetLedger }= addResult
                debug('green',`SOLVED (in ${block.powTime}s) block: transactionCnt(${transactionCnt}) (hashes: ${hashes.length}, resetLedger->`
                             +`${resetLedger ? 'Yes! *Problem*' : 'No? Good!'}); scanning pendingTransactions and removing any that were published in this block.` )

                // now remove them from pendingTransactions
                this.prunePendingTransactions( hashes )
                
                // tell everyone about block
                this.broadcastPeers({ path: '/blocks/announce', data: [block] })

                // ready to tackle another block
                this.worker.status = 'READY'
                break
                }
            case 'CLEANUP': {
                // appear to be transactions to revert too!
                if( this.worker.block?.transactions?.length > 0 ){
                    debug('cyan',`.. reverting mined block #${this.worker.block.index}: ${this.worker.block.transactions.length} transactions`)
                    let pendingTransRevert = 0, deleteTrans = 0
                    this.worker.block.transactions.forEach( t => {
                        // we do blockchain.transactionReverse as we do not want to remove from pending, will try again, new block#!
                        const result = this.transactionReverse( t )
                        if( result.error )
                            debug('red', result.error )
                        else if( result.transHashCleared ) 
                            pendingTransRevert++
                        else
                            deleteTrans++
                    })
                    debug('cyan',`    \ ${pendingTransRevert} transactions reset to pendingTransactions; ${deleteTrans} transactions (mining fees, rewards?) fully deleted. No residual effect from the mined block.`)

                } else {
                    // only need to undo rewards as block transactions can still be added to another block
                    rewardTransactions = rewardTransactions.filter( t => !t.error )
                    if( rewardTransactions.length === 0 ){
                        debug('dim',`.. came to ${this.worker.status} but nothing to undo. `)
                        this.worker.status = 'READY'
                        break
                    }

                    rewardTransactions.forEach( t => {
                        const result = this.transactionReverse( t )
                        if( result.error ) debug('red', result.error)
                    })
                }
                // TODO release stake claim on these?

                this.worker.status = 'READY'
                this.nodeState = 'ONLINE'
                break
                }
            }

            // Update ledger balances using minted block, and change in transactions
            // this.blockchainLedgerBalances( newIndex )
        } 
        
        // check-in every so often and try mining or seeing progress on mining
        setInterval(() => {
            if (this.worker.status !== 'READY' || 
                (this.pendingTransactions.filter( t => t.txStake.startsWith(this.nodeName+':'))).length > 0) {
                workerMinePending()
            }
        }, MINE_INTERVAL * 1000); // Try to mine a new block every MINE_INTERVAL seconds
    }
}
