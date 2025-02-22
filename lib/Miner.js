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
import { urlCall, sha256Hash, fixRounding, time, waitReady } from './helper.js'

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, hosts, dataPath }) {
        console.log(`\n\n**MINER** Created nodeName(${nodeName} @ ${host}:${port}) hosts(${hosts})`)
        console.log(`========================================================================`)
        this.version = '0:1.0'              // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.nodeState = 'LOADING'          // LOADING, ONLINE, REBUILDING, OFFLINE
        this.startTime = time()
        this.host = `http://${host}:${port}`
        this.peers = {}
        this.pendingTransactions = []       // mempool transactions want to put into an upcoming block
        this.rejectedTransactions = []      // mempool of recently rejected
        this.dataPath = dataPath
        this.workerStatus = ''
        this.workerBlock = {}
        this.worker = null

        // add hardcoded peers, including self
        hosts.push(this.host)
        this.addPeerHosts( hosts ) //peers.map( peer =>{ return { hostname: peer, dir: 'out', pingNext: time()-300, pingError: 0 } })

        // the address wallets
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        // setup wallet for this miner (if not already existing)
        this.ledger.createWallet(nodeName)
        // reset the balances; compile ledger based on blockchain
        this.ledger.reset()

        // init blockchain
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, dataPath })
        // BUGBUG remove 
        console.log( `\n== LEDGER ========================================`)
        this.ledger.walletBalances()

        // Start mining Worker thread
        this.#startMinerThread()
        // Run periodic mining attempt (that offloads task to worker)
        this.mine()

        // everything worked, our node should now be online able to respond to queries
        this.nodeState = 'ONLINE'

        // Make presence known
        this.broadcastPeers({ path: '/node/announce', data: this.pingInfo(this.blockchain.height()) })
            .then( response => this.pingResponseProcess(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
    }
    
    #startMinerThread(){
        this.worker = new Worker(path.resolve('./lib', 'MinerWorker.js'))
        this.worker.on('message', ({ action, ...result }) => {
            switch( action ){
                case 'UPDATE':
                    console.log( `  ~ [Miner] Update from worker (nonce=${result.nonce}, elapsed=${result.elapsed}s)` )
                    break
                case 'SOLVED':
                    this.workerBlock = result.block
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
                console.log( ` this.peers NEW host: ${host}`)
                this.peers[host] = { hostname: host, dir: 'out', pingNext: time()-300, pingError: 0 }
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
                this.broadcastPeers({ path: '/node/announce', hosts: pingNextHosts, data: this.pingInfo(this.blockchain.height()) })
                    .then( response => this.pingResponseProcess(response) )

                // check if any have a longer blockchain, and grab those new blocks!
                this.syncMissingBlocks()
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
            hostname: this.host,
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
        if( queryBlockIndex <= this.blockchain.height() )
            response.blockAtHeight = { index: this.blockchain.getBlock(queryBlockIndex).index, hash: this.blockchain.getBlock(queryBlockIndex).hash }
        
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
            const peer = this.peers[node.hostname]
            if( node.error ){
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

        console.log( `   .. [syncMissingBlocks] connected peers:` + peers.map( node => node.nodeName ? `${node.nodeName} [${node.blockchainHeight}]|(${node.pendingTransactions?.length || 0})` : '' ).join(' ') )
        const selNode = peers.reduce((max, item) => item.blockchainHeight > max.blockchainHeight ? item : max)

        if( selNode.blockchainHeight <= this.blockchain.height() )
            return { error: false }  // same height, nothing more to do.

        // not yet updated info
        // console.log( ` !selNode.blockAtHeight?.index(${!selNode.blockAtHeight?.index}) (${!selNode.blockAtHeight.index}) `)
        if( !selNode.blockAtHeight || selNode.blockAtHeight?.index === undefined ) return { error: false }

        this.nodeState = 'LOADING'

        // get node with the longest chain
        console.log( `[${selNode.hostname}] has a longer blockchain (${selNode.blockchainHeight})` )
        let latestBlock = this.blockchain.getBlock() // latest block

        // if node's block at same height as ours matches, we can safely continue to build blockchain with it
        if( selNode.blockAtHeight.index !== latestBlock.index || selNode.blockAtHeight.hash !== latestBlock.hash ){
            // this.peers = this.peers.filter( node => node.hostname !== selNode.hostname )
            console.log( ` x Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, finding last common node, and overwriting rest` )

            // request last 100 hashes and we'll try to find last matching block
            const fromIndex = Math.max(0, this.blockchain.height()-100 )
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks/hashes?fromIndex=${fromIndex}`, nodeToken: this.nodeName })
            if( response.error ) return response
            // now work our back way to find first matching chain
            for( let i=this.blockchain.height()-fromIndex; i>0; i-- ){
                if( this.blockchain.getBlock(i+fromIndex).hash !== response.result[i-1] ){
                    console.log(`  .. block #${i} different, deleting ours!`)
                    this.blockchain.removeBlock()
                } else {
                    latestBlock = this.blockchain.getBlock()
                    console.log(` .. found MATCH @ #${i}/${latestBlock.index}, syncing from there.`)
                    // REFRESHING our latest block to now be the trimmed chain
                    // console.log( `       latestBlock:`, latestBlock )
                    break
                }
            }
            // return { error: `Node (${selNode.hostname}) has more blocks, but MISMATCHING index/hash @ #${latestBlock.index}, DE-peering` }
        }

        console.log( ` > their chain matches mine to #(${latestBlock.index}), requesting MORE (/blocks?fromIndex=${latestBlock.index})... latestBlock:`)
        let addResult
        try {
            // since we aren't longest don't accept calls for now?
            const response = await urlCall({ hostname: selNode.hostname, path: `/blocks?fromIndex=${latestBlock.index}`, nodeToken: this.nodeName })
            if( response.error ) return response

            // add these new blocks, first write them, then sync transactions
            const newBlocks = response.result
            // console.log( ` adding: newBlocks: `, newBlocks )
            addResult = this.blockchain.addBlockchain(newBlocks)
            if( addResult.error ) return addResult

            this.prunePendingTransactions( addResult.hashes )

        } catch (e) {
            console.log(`     ! Error with peer: ${e.message}`)
            return { error: e.message }
        }

        this.nodeState = 'ONLINE'

        const { addBlockCnt, transactionCnt }= addResult
        return { error: false, addBlockCnt, transactionCnt }
    }

    async broadcastPeers({ path, data = '', hosts = Object.keys(this.peers) }) {
        const all = hosts === '*'
        if( all ) hosts = Object.keys(this.peers)
        const broadcastPeers = hosts.filter( host => (all || (this.peers[host]?.dir === 'out' && this.peers[host].pingNext < time())) ) // only those allowing ping
        // console.log( `[broadcastPeers] (${broadcastPeers.join(',').replace('http://','')})` )
        // console.log( ` .... broadcastPeers:`, broadcastPeers )
        if( broadcastPeers.length>0 ) console.log(`<< [${this.nodeName}]${path} @ (${broadcastPeers.map( node => node.hostname ).join(',')})` )

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
                    this.broadcastPeers({ path: '/node/announce', hosts: newHosts, data: this.pingInfo(this.blockchain.height()) })
                        .then( response => this.pingResponseProcess(response) )
                }
                return response //  { ...response, hostname: peer.hostname }

            } catch (e) {
                console.error(`Error with peer ${host}: ${e.message}`)
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
            this.pendingTransactions.filter( t => t.hash !== hash )

        return transResult
    }

    prunePendingTransactions( hashes ){
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
let srcWallet = {}
                const calc = this.blockchain.calcMiningReward(this.blockchain.height()+1)
                this.blockchain.miningReward = calc.miningReward
                this.blockchain.difficulty = calc.difficulty

                // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
                // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
                //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)
                // ORDER BY type='minerDeposit' || type='mintIssue', txSig <> '', timestamp ASC, src ASC, seq ASC  LIMIT 10
                mineTransactions = this.pendingTransactions
                    .filter(t => t.txStake.startsWith(this.nodeName + ':'))
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
                    
                        if (!src.startsWith('_')) {
                            // enforce transaction SEQ must be chronological from last block transaction seq+1
                            if (!blockSeq[src]) {
                                // const srcWallet = this.ledger.getWallet(src)
                                srcWallet = this.ledger.getWallet(src)
                                console.log( `srcWallet: `, srcWallet )
                                blockSeq[src] = srcWallet.blockSeq
                            }
                            // console.log( `    ... seq(${seq}) blockUserSeq+1(${blockSeq[src].seq+1})`)
                            if (seq !== ((blockSeq[src]?.seq || 0) + 1)) {
                                console.log(`    !! removing ${t.txStake?.split(':')[0] || ''} transaction ${src.split(':')[0]}/${seq} $ ${t.amount}: blockSeq(${blockSeq[src]?.seq || 'n/a'}) from mining set`)
                                // if the pending transaction is OLDER than the current block seq, that means there must have been duplicate (node spammed?), cancel these.
                                if( blockSeq[src]?.seq >= seq ){
                                    console.log(`    xx this transaction seq(${seq}) older than blockSeq(${blockSeq[src]?.seq}), will never be minted, so kill it! `)
                                    this.broadcastPeers({ path: '/transactions/expired', data: [t], hosts: '*' })
                                    this.rejectedTransactions.push( this.transactionReverse( t ) )
                                }
                                
                                return false
                            } else {
                                console.log(`  * queued ok: t.seq(${seq}) blockSeq[t.src](${blockSeq[src]?.seq}) srcWallet.tx.seq(${srcWallet.tx.seq})`)
                                blockSeq[src].seq++
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
                this.workerBlock = { index: blockData.index }
                this.worker.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.blockchain.difficulty})
                break
                }
            case 'MINING': {
                // while mining it will loop back to this place
                // this.worker.postMessage({action: 'ABORT' ) // abort if taking too long?
                // console.log( ' ~ [Miner] checking in, worker still mining' )
                break;
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
                console.log( `SOLVED (in ${block.powTime}s) block: transactionCnt(${transactionCnt}) (newHashes: ${newHashes.length} new for transactionHashes); scanning pendingTransactions and removing any that were published in this block.` )

                // now remove them from pendingTransactions
                this.prunePendingTransactions( hashes )
                // console.log( ` remove hashes in block: ${hashes.join(',')}`)
                // this.pendingTransactions = this.pendingTransactions.filter( t => !hashes.includes(t.hash) )

                
                if( this.pendingTransactions.length>0 ) console.log( `pendingTransactions left: `, this.pendingTransactions )    
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