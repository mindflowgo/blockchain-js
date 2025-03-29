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
import TransactionManager from './MinerTransactionManager.js'
import Blockchain from './Blockchain.js'
import Ledger from './Ledger.js'
import { Worker } from 'worker_threads'
import { urlCall, sha256Hash, fixRounding, time, waitReady, debug } from './helper.js'

const MINER_VERSION = '0:1.1'

const MINING_TIMEOUT = 7200                 // if mining hanging, reset to READY after this time
const MINING_PAUSE_TIMEOUT = 120            // if paused kill it after 120s
const MINE_INTERVAL = 10                    // how often to check updates from worker thread and queue work
const HEARTBEAT_INTERVAL = 30               // how often to announce heartbeat, check blockchain height
const NODE_TIMESTAMP_TOLERANCE = 1800       // how much can a node be different than our time before ignoring it
const PENDING_TRANSACTION_STALE = 600       // time after which we flush pending as stale
const ONLINE_DELAY = 10                     // wait 70s before mining

// Miner Class =================================================================================
export default class Miner {
    constructor({ nodeName, host, port, hosts, dataPath }) {
        this.version = MINER_VERSION        // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.nodeState = 'PREPARING'        // PREPARING (at start awaiting peer discovery) > ONLINE > SYNC_CHAIN|ADD_CHAIN > ONLINE
        this.startTime = time()
        this.hostname = `http://${host}:${port}`
        this.peers = {}
        this.dataPath = dataPath
        this.heartbeatCnt = 0
        this.worker = { 
            node: null,
            status: 'IDLE',
            startTime: 0,
            block: null
        }

        // add hardcoded known peers, including self
        hosts.push(this.hostname)
        this.addPeerHosts( hosts )

        // the address wallets, create wallet for miner, reset balances (re-established as blockchain built)
        this.ledger = new Ledger( path.join(this.dataPath, this.nodeName, 'ledger.json') )
        this.ledger.createWallet(nodeName)
        this.ledger.reset()

        // init transaction management
        this.transactionManager = new TransactionManager({ nodeName, ledger: this.ledger })

        // init blockchain (load or create)
        debug('dim')
        this.blockchain = new Blockchain({ nodeName, version: this.version, ledger: this.ledger, transactionManager: this.transactionManager, dataPath })
        // pass blockchain to transactions class
        this.transactionManager.blockchain = this.blockchain
        debug('reset')

        // BUGBUG remove 
        debug('bold', 
             `\n\n== MINER ==========================================================`
            +`\n${this.nodeName} / ${this.version} Listening(${host}:${port}) Peers(${hosts.join(' ').replaceAll(this.hostname,'').replaceAll('http://localhost','').trim()})`
            +`\nAddress: ${this.ledger.getPublicKey(this.nodeName)}`
            +`\nBlock Height: ${this.blockchain.height()}`
            +`\n== LEDGER =========================================================`)
        this.ledger.walletBalances()
        debug(`\n\n\n`)

        // Start mining Worker thread
        this.startMinerWorker()

        // Run periodic mining attempt (that offloads task to worker)
        this.startMining()

        // Announce node to known hosts
        this.broadcastPeers({ path: '/node/announce', data: this.pingInfo(this.blockchain.height()-1) })
            .then( response => this.pingResponseProcess(response) )
        
        // periodic check-in with everyone
        this.heartbeat()
        setInterval( ()=>{ this.heartbeat() }, HEARTBEAT_INTERVAL * 1000)
    
        // online come online after it's had time to update chain, discover peers, etc
        setTimeout( ()=>{ this.nodeState = 'ONLINE' }, ONLINE_DELAY * 1000 )

    }

    stateOffline( state ){
        if( this.nodeState !== 'PREPARING' ) this.nodeState = state
    }

    stateOnline(){
        if( this.nodeState !== 'PREPARING' ) this.nodeState = 'ONLINE'
    }


    startMinerWorker(){
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

    nodeStats() {
        const toMb = ( name, val ) =>{ const stat = (val / 1024 / 1024).toFixed(1); return stat > 5 ? `${name}: ${stat}MB, ` : '' }
        const memoryUsage = process.memoryUsage() // memoryUsage.heapUsed,
        debug('blue',`${this.nodeState}; Stats: Memory Usage - ${toMb('Total',memoryUsage.rss)}${toMb('Heap',memoryUsage.heapTotal)}`
                   +`${toMb('Array Buffers',memoryUsage.arrayBuffers)}${toMb('External',memoryUsage.external)}`)
    }
      
    async heartbeat(){
        // real BTC server: send heartbeach every 30mins, if none after 90, assume client connection closed
        // us: send every 30s, 120s assume gone
        // if( _heartbeat_peers ) console.log( `[heartbeat] (${this.peers.map(peer => peer.hostname).join(',')})`)
        this.nodeStats()
        this.heartbeatCnt++

        const peers = Object.values(this.peers).map( node => node.hostname )
        if (peers.length > 0) {
            this.broadcastPeers({ path: '/node/announce', hosts: peers, data: this.pingInfo() })
                .then( response => this.pingResponseProcess(response) )

            // check if any have a longer blockchain, and grab those new blocks!
            this.stateOffline('SYNC_CHAIN')
            const { hostname, height }= this.findPeerMostBlocks()
            if( height && height > 0 ){
                const result = await this.syncPeerBlocks( hostname )
                if( result.error ) debug( 'red', result.error )
            }
            this.stateOnline()
    
            // clear out stale pendingTransactions
            const staleHashes = this.transactionManager.deletePending({ timestamp: time()-PENDING_TRANSACTION_STALE })
            if( staleHashes ){
                debug('cyan',`   ~ Cleared stale pending transactions: ${staleHashes}`)
                // sync values for these names
                this.transactionManager.syncToChain()

            } else if( this.heartbeatCnt%10 === 0 ) 
                // run every heartbeat regardless
                this.transactionManager.syncToChain()
        }
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
            pendingTransactionsCnt: this.transactionManager.pendingCnt(),
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
    findPeerMostBlocks(){
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
            return { error: false }
        }

        // A BETTER chain exists - let's find from whence we shall sync and redo ours.
        debug( 'bold', ` x US (${this.nodeName}) vs THEM (${selNode.nodeName}): blocks(${this.blockchain.height()} vs ${selNode.blockchainHeight}) timestamp(${latestBlock.timestamp} vs ${selNode.blockAtHeight?.timestamp || 'n/a'}) (ours: #${latestBlock.index}/${latestBlock.timestamp}, theirs: #${selNode.blockAtHeight?.index || 'n/a'}/${selNode.blockAtHeight?.timestamp || 'n/a'}, finding last common node, and overwriting rest` )

        // now sync from this one
        return { error: false, height: selNode.blockchainHeight, hostname: selNode.hostname }
    }

    async syncPeerBlocks(hostname){
        // request last 100 hashes [arbitrary choice] and we'll try to find last matching block
        const fromIndex = Math.max(0, this.blockchain.height()-100 )
        const response = await urlCall({ hostname, path: `/blocks?fromIndex=${fromIndex}&type=hashes`, nodeToken: this.nodeName })
        if( response.error ) return response

        // now work our back way to find highest matching block
        const latestBlock = this.blockchain.getBlock()
        let index = latestBlock.index
        for( let i=this.blockchain.height()-1; i >= fromIndex; i-- ){
            if( !response.result[i-fromIndex] ) return { error: `Invalid /blocks result: `, result: response.result }

            if( this.blockchain.getBlock(i).hash === response.result[i-fromIndex].hash ){
                index = i
                debug('bold', ` ~ found MATCH @ #${i}, syncing from there.`)
                break
            }
        }

        debug('cyan',` > [${hostname}] chain matches mine to #(${index}), getting remainder and overwriting ours ... `)
        let responseBlocks, foundHashes = []
        try {
            // since we aren't longest, nodeState should not be ONLINE, as we attempt to sync-up
            responseBlocks = await urlCall({ hostname, path: `/blocks?fromIndex=${index+1}`, nodeToken: this.nodeName })
            if( responseBlocks.error ) return responseBlocks

            // add these new blocks, first write them, then sync transactions
            const newBlocks = responseBlocks.result
            if( newBlocks.length>0 ){
                debug('dim',`   + got blocks to add: ` + newBlocks.map( b => b.index ).join(',') )
                const addResult = this.blockchain.addBlockchain(newBlocks, { forceOverwrite: true, txUpdate: true })
                if( addResult.error ) return addResult
                // if any of these are in pending, remove them
                foundHashes = this.transactionManager.deletePending({ hashes: addResult.hashes })
                debug('dim',`  >>> added ${addResult.addBlockCnt} blocks containing ${addResult.transactionCnt} transactions; pruned pending transactions (${foundHashes})` )
                if( addResult.resetLedger ){
                    debug('green', "Note: resetLedger called, so syncing multiple prior blocks...")
                }
            }
            return { error: false, foundHashes }

        } catch (e) {
            debug('red',`     ! Error with peer: ${e.message} urlCall(/blocks?fromIndex=${index+1}) -> response: `, responseBlocks )
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
            const pending = path.includes('/node/announce') ? ` pendingTransactions(${this.transactionManager.pendingCnt()})` : ''
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

    // mining state machine
    startMining() {
        let mineTransactions = []
        let rewardTransactions = []
        this.worker.status = 'READY'
        
        const workerMinePending = () => {
        switch( this.worker.status ){
            case 'READY': {
                // clear queues
                rewardTransactions = []
                const blockIdx = this.blockchain.height()
                this.blockchain.calcMiningReward({ index: blockIdx })

                // gather transactions to mine, use ones staked by us
                mineTransactions = this.transactionManager.getPending({ ofMiner: this.nodeName, maxTransactions: this.blockchain.transactionLimit.max })
                // min limit per block, have a kitkat, take a break!
                if( mineTransactions.length < this.blockchain.transactionLimit.min ) break

                debug('cyan',`*** MINING START (${this.nodeName}) *** (difficulty: ${this.blockchain.difficulty}) reward=${this.blockchain.miningReward} mineTransactions=${mineTransactions.length}` )
                debug('dim')
                // prepare the mining fee transaction to accompany mineTransaction
                mineTransactions.forEach( t => {
                    if( t.fee>0 ) 
                        rewardTransactions.push( 
                            // automated so don't go through transactionManager (ie dropping it on failure is fine!)
                            this.ledger.transaction({ src: '_mint', dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash }, { blockIdx, testOnly: true }) )
                            // this.transactionManager.new(
                            //     { src: '_mint', dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash }, { blockIdx, testOnly: true } ) )
                })

                // block mining reward
                if( this.blockchain.miningReward>0 )
                    rewardTransactions.push( 
                        this.ledger.transaction({ src: '_mint', dest: this.nodeName, amount: this.blockchain.miningReward, type: 'miningReward' }, { blockIdx, testOnly: true })
                        // this.transactionManager.new(
                        //     { src: '_mint', dest: this.nodeName, amount: this.blockchain.miningReward, type: 'miningReward' }, { blockIdx, testOnly: true })
                )

                debug('reset')

                // problems setting up rewardTransactions? ABORT!
                if( rewardTransactions.filter( t => t.error ).length > 0 ){
                    debug('dim',` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
                    this.worker.status = 'CLEANUP'
                    break
                }

                // Construct the block with the above transactions that we'll ATTEMPT to mine
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const newBlock = this.blockchain.addBlock({ transactions: [ ...mineTransactions, ...rewardTransactions ] }, { prepareOnly: true })
                if( newBlock.error ){
                    debug('dim',` ~ [Miner] addBlock failed with transaction ${newBlock.transaction.hash}, dropping it before re-attempting to mine.`)
                    if( newBlock.transaction.hash ) // failed due to this particular transaction, so we will delete it and try again and try again
                        this.transactionManager.deletePending({ hashes: [ newBlock.transaction.hash ] })
                    this.worker.status = 'CLEANUP'
                    break
                }

                // offload to worker thread to solve (keeps system responsive, could allow pool of workers)
                this.worker.status = 'MINING'
                this.worker.startTime = time()
                this.worker.block = {}
                this.worker.node.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.blockchain.difficulty})
                break
                }
            case 'MINING':
            case 'MINING_PAUSE':
            case 'SOLVED_PAUSE': {
                // Check for mining timeout
                const elapsed = time() - this.worker.startTime
                if (this.worker.status === 'MINING' && elapsed > MINING_TIMEOUT) {
                    debug('green',` ! Mining timeout after ${elapsed}s. Aborting.`)
                    this.worker.node.postMessage({action: 'ABORT'})
                } else if(this.worker.status !== 'MINING' && elapsed > MINING_PAUSE_TIMEOUT) {
                    debug('green',` ! Paused timeout after ${elapsed}s. Aborting.`)
                    this.worker.node.postMessage({action: 'ABORT'})
                } else {
                    debug('dim',` ~ [Miner] checking in (${this.worker.status}), worker still mining (${elapsed}s elapsed)`)
                }
                break
                }
            case 'SOLVED': {
                // Worker thread should have solved, now 'this.workerBlock' has a full solution nonce
                this.stateOffline('ADD_CHAIN')
                const addResult = this.blockchain.addBlockchain([this.worker.block])
                const { error, hashes, transactionCnt, resetLedger, blocks }= addResult
                if( error ){
                    this.worker.status = 'CLEANUP'
                    break
                }
                this.stateOnline()
                debug('green',`SOLVED (in ${blocks[0].powTime}s) block: transactionCnt(${transactionCnt}) (hashes: ${hashes?.length}, resetLedger->`
                             +`${resetLedger ? 'Yes! *Problem*' : 'No? Good!'}); scanning pendingTransactions and removing any that were published in this block.` )

                // now remove them from pendingTransactions
                this.transactionManager.deletePending({ hashes })

                // tell everyone about block
                this.broadcastPeers({ path: '/blocks/announce', data: blocks })

                // ready to tackle another block
                this.worker.status = 'READY'
                break
                }
            case 'CLEANUP': {
                // appear to be transactions to revert too!
                if( this.worker.block?.transactions?.length > 0 ){
                    debug('cyan',`.. reverting mined block #${this.worker.block.index}: ${this.worker.block.transactions.length} transactions`)
                    
                    // if we triggered cleanup, undo these transactions
                    // since the block we created was overwritten by another, these are technically NOT block entries to reverse
                    // rather, they are pending to reverse

                    const { error, pending }= this.transactionManager.reverseMineAborted(this.worker.block.transactions)
                    if( error ) debug('red', error)
                    debug('cyan',`    \ ${pending} transactions reset to pendingTransactions.`)
                }
                // TODO release stake claim on these?

                this.worker.status = 'READY'
                this.stateOnline()
                break
                }
            }
        } 
        
        // node must be online, and then mine if pending exist or if it's in not in idle mode (READY)
        setInterval(() => {
            if (this.nodeState === 'ONLINE' && (this.worker.status !== 'READY' || this.transactionManager.pendingCnt(this.nodeName)) ){
                workerMinePending()
            }
        }, MINE_INTERVAL * 1000); // Try to mine a new block every MINE_INTERVAL seconds
    }
}
