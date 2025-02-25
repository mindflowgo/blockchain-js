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

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, hosts, dataPath }) {
        debug( 'bright', `\n\n**MINER** Created nodeName(${nodeName} @ ${host}:${port}) hosts(${hosts})`
              +`\n========================================================================` )
        this.version = '0:1.0'              // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.nodeState = 'LOADING'          // LOADING, ONLINE, REBUILDING, OFFLINE
        this.startTime = time()
        this.workerStartTime = 0            // Track when mining starts for timeout handling
        this.hostname = `http://${host}:${port}`
        this.peers = {}
        this.pendingTransactions = []       // mempool transactions want to put into an upcoming block
        this.rejectedTransactions = []      // mempool of recently rejected
        this.dataPath = dataPath
        this.workerStatus = ''
        this.workerStartTime = 0
        this.workerTimeout = 3600           // how long till force worker to stop mining ?
        this.workerBlock = {}
        this.worker = null

        // add hardcoded peers, including self
        hosts.push(this.hostname)
        this.addPeerHosts( hosts ) //peers.map( peer =>{ return { hostname: peer, dir: 'out', pingNext: time()-300, pingError: 0 } })

        // the address wallets
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        // setup wallet for this miner (if not already existing)
        this.ledger.createWallet(nodeName)
        // reset the balances; compile ledger based on blockchain
        this.ledger.reset()

        // init blockchain
        debug( 'dim' )
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, dataPath })
        debug( 'reset' )
        
        // BUGBUG remove 
        debug( 'bright', 
             `\n\n== ADDRESS ==========================================`
            +`\n${this.nodeName}:${this.ledger.getPublicKey(this.nodeName)}`
            +`\n== LEDGER ===========================================` )
        this.ledger.walletBalances()
        debug(`\n\n\n`)

        // Start mining Worker thread
        this.#startMinerThread()
        // Run periodic mining attempt (that offloads task to worker)
        this.mine()

        // everything worked, our node should now be online able to respond to queries
        this.nodeState = 'ONLINE'

        // Make presence known
        this.broadcastPeers({ path: '/node/announce', data: this.pingInfo(this.blockchain.height()-1) })
            .then( response => this.pingResponseProcess(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
    }
    
    #startMinerThread(){
        this.worker = new Worker(path.resolve('./lib', 'MinerWorker.js'))
        this.worker.on('message', ({ action, ...result }) => {
            switch( action ){
                case 'UPDATE':
                    console.log( `  ~ [Miner] Worker update (nonce=${result.nonce}, elapsed=${result.elapsed}s)` )
                    break
                case 'ABORT':
                    console.log( `  ~ [Miner] Worker notified aborted; elapsed=${result.elapsed}s. Ready again.` )
                    this.workerStatus = 'READY'
                    break
                case 'UNSOLVED':
                    console.log( `  ~ [Miner] Worker notified going to abort, couldn't find match in nonse-range (elapsed=${result.elapsed}s)` )
                    this.workerStatus = 'READY'
                    break    
                case 'SOLVED':
                    this.workerBlock = result.block
                    if( this.workerStatus === 'MINING_PAUSE' )
                        this.workerStatus = 'SOLVED_PAUSE'
                    else
                        this.workerStatus = 'SOLVED'
                    break
            }
        })
      
        this.worker.on('error', (error) => {
            console.error('Worker error:', error)
        })
    
        this.worker.on('exit', (code) => {
            console.error(`Worker stopped with exit code ${code}`); // code 0 = normal
        })
    }

    addPeerHosts( hosts ){
        let newHosts = []
        hosts.forEach( host => {
            if( this.peers[host] === undefined ){
                console.log( `   + NEW peer: ${host}`)
                this.peers[host] = { hostname: host, nodeName: '', dir: 'out', pingNext: time()-300, pingError: 0 }
                newHosts.push(host)
            }
        })
        return newHosts
    }

    heartbeat(){
        // real BTC server: send heartbeach every 30mins, if none after 90, assume client connection closed
        // us: send every 30s, 120s assume gone
        setInterval(async () => {
            // const _heartbeat_peers = this.peers.map(peer => peer.hostname).join(',')
            // if( _heartbeat_peers ) console.log( `[heartbeat] (${_heartbeat_peers})`)
            const peers = Object.values(this.peers)
            if (peers.length > 0) {
                // only ping peers after delay (pingNext)
                const pingNextHosts = peers.filter(node => node.pingNext < time()).map( node => node.hostname )
                this.broadcastPeers({ path: '/node/announce', hosts: pingNextHosts, data: this.pingInfo(this.blockchain.height()-1) })
                    .then( response => this.pingResponseProcess(response) )

                // check if any have a longer blockchain, and grab those new blocks!
                this.nodeState = 'LOADING'
                const syncResult = this.syncMissingBlocks()
                if( syncResult.error ) debug( 'red', syncResult.error )
                this.nodeState = 'ONLINE'
        
            }
        }, 10000)
    }

    pingInfo( queryBlockIndex=-1 ){
        // connect to a peer, send: version number, block count, hash of latest, and current time
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

        // they want to know about a specific chain item (queryBlockItem), send it
        // with this, they can verify our blockchains sync to that point
        if( queryBlockIndex < this.blockchain.height() )
            response.blockAtHeight = { index: this.blockchain.getBlock(queryBlockIndex).index, 
                                       hash: this.blockchain.getBlock(queryBlockIndex).hash, 
                                       timestamp: this.blockchain.getBlock(queryBlockIndex).timestamp }
        
        return response
    }

    pingResponseProcess( response ){
        if( response.error || response.result.length<1 )
            return { error: response.error || false} // nothing to process, maybe no nodes

        // review each response
        const NEXT_PING = 30 // 120
        const ERROR_PING = 15 // 300
        for( let node of response.result ){
            // setup pingNext for this peer
            if( node.error ){
                const peer = this.peers[node.hostname]
                peer.pingError = (peer.pingError || 0) + 1
                peer.pingNext = time() + peer.pingError * ERROR_PING // 300
            } else {
                // gather all self-reporting data from peer into this
                delete node.error
                delete node.peers
                this.peers[node.hostname] = { ...this.peers[node.hostname], ...node, pingNext: time() + NEXT_PING, pingError: 0 } // ...this.peers[peerIdx],
            }
        }
    }

    // scan through peers and see if we should ask for blocks from anyone
    async syncMissingBlocks(){
        const peers = Object.values(this.peers)
        if( peers.length<1 )
            return { error: `No nodes to connect with. Aborting.`}

        const latestBlock = this.blockchain.getBlock()
        let index = latestBlock.index // our latest block

        // find (if any) node with longest chain
        // if same height, take one with oldest block timestamp
        let selNode = peers.reduce((sel, item) => item.blockchainHeight >= sel.blockchainHeight ? item : sel)
        if( selNode.blockchainHeight === this.blockchain.height() && selNode.blockAtHeight.index === index ) 
            selNode = peers.reduce((sel, item) => item.blockchainHeight === sel.blockchainHeight && item.blockAtHeight.timestamp < sel.blockAtHeight.timestamp ? item : sel)

        if( !selNode?.nodeName || selNode.blockchainHeight < this.blockchain.height() || selNode.blockAtHeight.index < (this.blockchain.height()-1) || 
            (selNode.blockchainHeight === this.blockchain.height() && selNode.blockAtHeight.timestamp >= latestBlock.timestamp ) ){
            // there is no node with longer chain or same-height & older timestamp or there's a problem with selNode so don't proceed
            // console.log( `   .. [syncMissingBlocks] connected peers:` + peers.map( node => node.nodeName ? `${node.nodeName} [${node.blockchainHeight}]|(${node.pendingTransactions?.length || 0})` : '' ).join(' ') + ' but none with longer chain/older block.' )
            return { error: false, addBlockCnt: 0, transactionCnt: 0 }
        }

        // A BETTER chain exists - let's find from whence we shall sync and redo ours.
        // this.peers = this.peers.filter( node => node.hostname !== selNode.hostname )
        console.log( ` x US (${this.nodeName}) vs THEM (${selNode.nodeName}): blocks(${this.blockchain.height()} vs ${selNode.blockchainHeight}) timestamp(${latestBlock.timestamp} vs ${selNode.blockAtHeight?.timestamp || 'n/a'}) (ours: #${latestBlock.index}/${latestBlock.timestamp}, theirs: #${selNode.blockAtHeight?.index || 'n/a'}/${selNode.blockAtHeight?.timestamp || 'n/a'}, finding last common node, and overwriting rest` )

        // console.log( `[syncMissingBlocks] selNode:`, selNode )

        // request last 100 hashes [arbitrary choice] and we'll try to find last matching block
        const fromIndex = Math.max(0, this.blockchain.height()-100 )
        const response = await urlCall({ hostname: selNode.hostname, path: `/blocks/hashes?fromIndex=${fromIndex}`, nodeToken: this.nodeName })
        if( response.error ) return response

        // now work our back way to find highest matching block
        // console.log( `  .. requested 100 blocks from our height-100, ie fromIndex(${fromIndex})`, response.result )
        for( let i=this.blockchain.height()-1; i >= fromIndex; i-- ){
            if( !response.result[i-fromIndex] ) return { error: `Invalid /blocks/hashes result: `, result }

            if( this.blockchain.getBlock(i).hash === response.result[i-fromIndex].hash ){
                index = i
                debug( 'bright', `    ~ found MATCH @ #${i}, syncing from there.`)
                break
            }
        }

        console.log( ` > [${selNode.nodeName}] chain matches mine to #(${index}), getting remainder and overwriting ours (/blocks?fromIndex=${index+1})... `);
        let addResult
        try {
            // since we aren't longest don't accept calls for now?
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks?fromIndex=${index+1}`, nodeToken: this.nodeName })
            if( response.error ) return response

            // add these new blocks, first write them, then sync transactions
            const newBlocks = response.result
            console.log( `    + got blocks to add: ` + newBlocks.map( b => b.index ).join(',') )
            addResult = this.blockchain.addBlockchain(newBlocks, { forceOverwrite: true })
            if( addResult.error ) return addResult
            // if any of these are in pending, remove them
            const foundHashes = this.prunePendingTransactions( addResult.hashes )
            console.log( `  >>> added ${addResult.addBlockCnt} blocks containing ${addResult.transactionCnt} transactions; pruned pending transactions`, foundHashes )
            return { error: false, foundHashes }

        } catch (e) {
            console.log(`     ! Error with peer: ${e.message}`)
            return { error: e.message }
        }

        return { error: false, addBlockCnt: addResult.addBlockCnt, transactionCnt: addResult.transactionCnt }
    }

    async broadcastPeers({ path, data = '', hosts = Object.keys(this.peers) }) {
        const all = hosts === '*'
        if( all ) hosts = Object.keys(this.peers)

        const broadcastPeers = hosts.filter( host => this.peers[host].hostname !== this.hostname && (all || (this.peers[host]?.dir === 'out' && this.peers[host].pingNext < time())) ) // only those allowing ping
        // console.log( `[broadcastPeers] (${broadcastPeers.join(',').replace('http://','')})` )
        // console.log( ` .... broadcastPeers:`, broadcastPeers )
        if( broadcastPeers.length>0 && path !== '/node/announce') console.log(`<< [${this.nodeName}]${path} @ (${broadcastPeers.map( node => node.hostname ).join(',')})` )

        const requests = broadcastPeers.map(async (host, idx) => {
            // the 'node'
            const request = { hostname: host, path, nodeToken: this.nodeName }
            if (data) request.body = data
            try {
                const response = await urlCall(request)
                response.hostname = request.hostname
                if( response.error ) return response

                // only deal with servers that are within 30 minutes of us
                if( Math.abs(response.timestamp - time()) > 1800 )
                    throw new Error('Peers time unavailable / 30+ minutes off')

                // Update next ping time
                this.peers[host].pingNext = time() + 120
                
                // in our peers object, track some stuff from the responding peer
                for( let key of ['nodeName','version','nodeState','type','startTime','timestamp','pendingTransactionsCnt','blockchainHeight'] )
                    if( response[key] ) this.peers[host][key] = response[key]

                // if they have peers, let's add them & announce ourselves
                if( response.peers ){
                    const newHosts = this.addPeerHosts( response.peers )
                    this.broadcastPeers({ path: '/node/announce', hosts: newHosts, data: this.pingInfo(this.blockchain.height()-1) })
                        .then( response => this.pingResponseProcess(response) )
                }
                return response //  { ...response, hostname: peer.hostname }

            } catch (e) {
                // console.error(`Error with peer ${host}: ${e.message}`)
                return { error: e.message, hostname: request.hostname }
            }
        })
        const result = (await Promise.all(requests)).filter(res => res !== null)
        // console.log(`    - responses:`, responses)
        return { error: false, result }
    }


    // miner fee
    transactionFee({ amount, fee=0 }){
        // transaction occurs in Ledger, but we contribute the fee our miner charges here
        // users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        if( fee<0 ) fee = 0
        fee = fixRounding( Math.max(fee, Number(amount || 0) * this.blockchain.transactionFee) )
        return fee
    }
    
    // submit a transaction to miner
    transaction({src, dest, amount, fee = 0, seq = 0, txSig = '', hash = '', ...data}, blockIdx) {
        // Validate transaction
        if (!src || !dest || !amount) {
            console.log(`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
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
                console.log( `Invalid src sequence (seq=${seq}), expected ${srcWallet.tx.seq+1}` )
                return { error: `Invalid src sequence (seq=${seq}), expected ${srcWallet.tx.seq+1}`, seq: srcWallet.tx.seq+1 }
            }

            // verify there are excess pending from this src, reject it
            const transSrc = this.ledger.buildTransactionName(src, srcWallet.publicKey)
            const pendingSrcCnt = this.pendingTransactions.filter( t => t.src === transSrc ).length
            if( pendingSrcCnt>16 ) {
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

        return { ...newTransaction, balance: srcWallet.balance  }
    }

    transactionReverse({hash, ...data}, blockIdx = -1) {
        const transResult = this.blockchain.transactionReverse({hash, ...data}, blockIdx)
        if( !transResult.error ) // filter out entry
            this.prunePendingTransactions([hash])

        return transResult
    }

    prunePendingTransactions( hashes ){
        if( !hashes || hashes.length<1 ) return ''

        // BUGBUG this block is just debug
        const foundHashes = this.pendingTransactions.filter( pT => hashes.includes(pT.hash) ).map( t => t.hash ).join(',')
        if( foundHashes ) console.log( `   x removing pendingTransaction(${foundHashes})`)

        // remove from pendingTransactions (if there)
        this.pendingTransactions = this.pendingTransactions.filter( pT => !hashes.includes(pT.hash) )
        return foundHashes
    }


    // mining state machine
    mine() {
        let mineTransactions = []
        let rewardTransactions = []
        // let addTransactions = []
        let blockSeq = {}
        this.workerStatus = 'READY'
        
        const workerMinePending = () => {
        switch( this.workerStatus ){
            case 'READY': {
                // reset our working transactiong
                // TODO figure out better BUGBUG
                mineTransactions = []
                rewardTransactions = []
                // otherServerTransactions = []
                blockSeq = {}
                const calc = this.blockchain.calcMiningReward(this.blockchain.height())
                this.blockchain.miningReward = calc.miningReward
                this.blockchain.difficulty = calc.difficulty

                // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
                // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
                //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)
                // ORDER BY type='minerDeposit' || type='mintIssue', txSig <> '', timestamp ASC, src ASC, seq ASC  LIMIT 10
                mineTransactions = this.pendingTransactions
                    .filter(t => t.txStake.startsWith(this.nodeName + ':'))
                    // .filter(t => t.timestamp < (time()-60)) // give at least a minute for concensus before mining
                    .sort((a, b) => (
                        ['minerDeposit', 'mintIssue'].includes(b.type) - ['minerDeposit', 'mintIssue'].includes(a.type) ||
                        (b.hasOwnProperty('txSig') - a.hasOwnProperty('txSig')) ||
                        (a.timestamp - b.timestamp) ||
                        a.src.localeCompare(b.src) ||
                        (a.seq - b.seq)
                    ))
                    .filter((t) => {
                        const src = t.src
                        const seq = t.seq
                        let srcTx = '-'
                        if (!src.startsWith('_')) {
                            // enforce actual transaction SEQ in his block  must be chronological from last block transaction seq+1
                            if (!blockSeq[src]) {
                                // const srcWallet = this.ledger.getWallet(src)
                                const srcWallet = this.ledger.getWallet(src)
                                // console.log( `srcWallet: `, srcWallet )
                                blockSeq[src] = srcWallet.blockSeq?.seq || 0
                                srcTx = srcWallet.tx.seq
                            }
                            const nextSeq = blockSeq[src] + 1
                            if (seq === nextSeq) {
                                console.log(`*** Queued for mining: ${src.split(':')[0]}/${seq}  - blockSeq[src](${blockSeq[src]}) srcWallet.tx.seq(${srcTx})`)
                                blockSeq[src]++

                            } else if(seq > nextSeq) {
                                console.log(`    ~~ delaying mining ${t.txStake?.split(':')[0] || ''} transaction ${src.split(':')[0]}/${seq} $ ${t.amount}: blockSeq(${blockSeq[src]}) as its not chronological`)
                                return false

                            } else if(seq < nextSeq) {
                                // if the pending transaction is OLDER than the current block seq, that means there must have been duplicate (node spammed?), cancel these.
                                console.log(`    xx removing transaction s seq(${seq}) older than blockSeq(${blockSeq[src]}), will never be minted, so kill it! `)
                                this.broadcastPeers({ path: '/transactions/expired', data: [t], hosts: '*' })
                                this.rejectedTransactions.push( this.transactionReverse( t ) )
                                return false
                            }
                        }
                        return true
                    })
                    .slice(0, 10)                    
                
                // anything to mine for this node? if not wait till I can stake some transactions
                if( mineTransactions.length === 0 ) break

                console.log( `*** MINING START (${this.nodeName}) *** (difficulty: ${this.blockchain.difficulty}) reward=${this.blockchain.miningReward}`)
                mineTransactions.forEach( t => {
                    // indicate we are mining in th metadata -> in this.pendingTransactions
                    // const idx = this.pendingTransactions.find( pT => pT.hash === t.hash)
                    // if (idx) this.pendingTransactions[idx]
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
                    console.log( ` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
                    this.workerStatus = 'UNDO'
                    break
                }

                // append reward transactions to prepare our mining transaction block
                mineTransactions = [ ...mineTransactions.concat( rewardTransactions ) ]

                // remove miner meta-data (ex. txStake) as not included in block
                mineTransactions = mineTransactions
                    .filter(tx => tx !== undefined && tx !== null) // Filter out undefined/null values
                    .map( ({txStake, balance, ...data }) => data )
                // console.log( ` LBLOCK TRANSACTION:S`, mineTransactions )

                // no errors, great build markleTree and add block
                if( mineTransactions.length === 0 ){
                    console.log( `strange error, no mine transactions: `, this.pendingTransactions )
                    break
                }

                const [ merkleRoot ]= this.blockchain.merkleBuild( mineTransactions ).pop()

                const blockData = {
                    merkleRoot,
                    transactions: mineTransactions
                }
                // Create a new block with pending transactions, include calculated rewards mining server will get if this block accepted by other nodes
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const newBlock = this.blockchain.addBlock(blockData, { prepareOnly: true })
                if( newBlock.error ){
                    this.workStatus = 'UNDO'
                    break
                }

                // offload to worker thread to solve (keeps system responsive)
                this.workerStatus = 'MINING'
                this.workerStartTime = time()
                this.workerBlock = { index: blockData.index }
                this.worker.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.blockchain.difficulty})
                break
                }
            case 'MINING':
            case 'MINING_PAUSE':
            case 'SOLVED_PAUSE': {
                // Check for mining timeout
                const elapsed = time() - this.workerStartTime
                if (elapsed > this.workerTimeout) {
                    console.log(` ! Mining timeout after ${elapsed}s. Aborting.`)
                    this.worker.postMessage({action: 'ABORT'})
                } else {
                    console.log(` ~ [Miner] checking in (${this.workerStatus}), worker still mining (${elapsed}s elapsed)`)
                }
                break
                }
            case 'SOLVED': {
                // Worker thread should have solved, now 'this.workerBlock' has a full solution nonce
                this.nodeState = 'LOADING'
                const addResult = this.blockchain.addBlockchain([this.workerBlock])
                if( addResult.error ){
                    this.workerStatus = 'UNDO'
                    break
                }
                this.nodeState = 'ONLINE'
                const block = addResult.blocks[0]
                const { hashes, newHashes, transactionCnt }= addResult
                console.log( `SOLVED (in ${block.powTime}s) block: transactionCnt(${transactionCnt}) (hashes: ${hashes.length}, newHashes: ${newHashes.length} new for transactionHashes); scanning pendingTransactions and removing any that were published in this block.` )

                // now remove them from pendingTransactions
                this.prunePendingTransactions( hashes )
                // console.log( ` remove hashes in block: ${hashes.join(',')}`)
                // this.pendingTransactions = this.pendingTransactions.filter( t => !hashes.includes(t.hash) )

                
                // if( this.pendingTransactions.length>0 ) console.log( ` - pendingTransactions left: `, this.pendingTransactions )    
                // tell everyone about block
                this.broadcastPeers({ path: '/blocks/announce', hosts: '*', data: [block] })

                // ready to tackle another block
                this.workerStatus = 'READY'
                break
                }
            case 'UNDO': {
                // only need to undo rewards as block transactions can still be added to another block
                rewardTransactions = rewardTransactions.filter( t => !t.error )
                // console.log( 'undoHashes: ', undoHashes )
                if( rewardTransactions.length === 0 ){
                    console.log( `.. came to ${this.workerStatus} but nothing to undo. ` )
                    this.workerStatus = 'READY'
                    break
                }

                rewardTransactions.forEach( t => {
                    this.rejectedTransactions.push( this.blockchain.transactionReverse( t ) )
                })
                
                // TODO release stake claim on these

                this.workerStatus = 'READY'
                this.nodeState = 'ONLINE'
                break
                }
            }

            // Update ledger balances using minted block, and change in transactions
            // this.blockchainLedgerBalances( newIndex )
        } 
        
        // check-in every so often and try mining or seeing progress on mining
        setInterval(() => {
            if (this.workerStatus !== 'READY' || 
                (this.pendingTransactions.filter( t => t.txStake.startsWith(this.nodeName+':'))).length > 0) {
                workerMinePending()
            }
        }, 10000); // Try to mine a new block every minute, simulating delay that real miner has tackling complex PoW calcs
    }
}
