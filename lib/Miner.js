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
import { Worker } from 'worker_threads'

import TransactionHandler from './TransactionHandler.js'
import Blockchain from './Blockchain.js'
import Wallet from './Wallet.js'
import P2P from './P2P.js'
import Mempool from './Mempool.js'

import { urlCall, fixRounding, time, waitReady, debug } from './helper.js'

const MINER_VERSION = '1:1.1'

const MINING_TIMEOUT = 7200                 // if mining hanging, reset to READY after this time
const MINING_PAUSE_TIMEOUT = 120            // if paused kill it after 120s
const MINE_INTERVAL = 10                    // how often to check updates from worker thread and queue work
const NODE_TIMESTAMP_TOLERANCE = 1800       // how much can a node be different than our time before ignoring it
const DEBUG_MODE = 1

// Miner Class =================================================================================
export default class Miner {
    static {
        this.version = MINER_VERSION        // blockchain network : spec-version1.0
        this.nodeName = ''
        this.type = 'miner'                 // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.startTime = time()
        this.dataPath = ''
        this.worker = { 
            node: null,
            status: 'IDLE',
            startTime: 0,
            block: null
        }
        this.verbosity = 4 // 0 = none, 1 = major, 2 = more, 3 = all

        // these initialized when miner started
        this.TransactionHandler = null
        this.Mempool = null
        this.Blockchain = null
        this.Wallet = null
        this.P2P = null
    }

    static start({ nodeName, host, port, hosts, dataPath }) {
        this.nodeName = nodeName
        this.dataPath = dataPath

        // init transaction management system
        this.TransactionHandler = new TransactionHandler(this.nodeName)

        // the address wallets, create wallet for miner, reset balances (re-established as blockchain built)
        const walletFile = path.join(this.dataPath, this.nodeName, 'blockchain_addresses.json')
        this.Wallet = new Wallet( walletFile, this.TransactionHandler )
        // start/load mempool
        this.Mempool = new Mempool( this.Wallet )
        // update these classes for this...
        this.TransactionHandler.setHelperClasses(this.Mempool, this.Wallet)

        // each node needs it's own wallet, for issuing own tokens (if needed), 
        this.Wallet.generate(nodeName)
        // we reset tokens because reloading will re-generate the balances
        this.Wallet.resetAllTokens()

        // init blockchain (load or create)
        debug('dim')
        // blockchain directly uses these classes
        this.Blockchain = new Blockchain( this.version, this.nodeName, this.TransactionHandler, this.Mempool, this.Wallet )
        debug('reset')

        // init our this.P2P module
        this.P2P = new P2P( this.nodeName, host, port, hosts, this.Blockchain, ()=>{return this.Mempool.queueLen()} )
        

        if( this.verbosity>3 ){
            debug('bold', 
                `\n\n== MINER ==========================================================`
                +`\n${this.nodeName} / ${this.version} Listening(${host}:${port}) Peers(${hosts.join(' ').replaceAll(this.hostname,'').replaceAll('http://localhost','').trim()})`
                +`\nAddress: ${this.Wallet.getUserPublicKey(this.nodeName)}`
                +`\nBlock Height: ${this.Blockchain.height()}`
                +`\nWaiting some time before mining -> discovering peers...`
                // +`\nQueued get staled after ${Math.round(PENDING_TRANSACTION_STALE/6)/10} mins`
                +`\n== LEDGER =========================================================`)
            this.Wallet.balances()
            debug(`\n\n\n`)
        }

        // Start mining Worker thread
        this.startMinerWorker()

        // Run periodic mining attempt (that offloads task to worker)
        this.startMining()
    }

    static startMinerWorker(){
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

    // static pingInfo( queryBlockIndex=Blockchain.height()-1 ){
    //     // a node/announce includes key info about this node, including timestamp and who it knows, and block length
    //     // they send all their peers, if you block not latest, they will send up to 500 blocks ahead of it (then you process and request more)
    //     const response = {
    //         nodeName: this.nodeName,
    //         version: this.version,
    //         nodeState: this.nodeState,
    //         hostname: this.hostname,
    //         type: this.type,
    //         startTime: this.startTime,
    //         timestamp: time(),
    //         peers: Object.keys(this.peers), // only pass on hostname
    //         pendingTransactionsCnt: this.Mempool.pendingCnt(),
    //         blockchainHeight: Blockchain.height(),
    //         blockAtHeight: {}
    //     }

    //     // if info is response to another node, they specified their block-height,
    //     // we specify our hash/timestamp for that height-block
    //     if( queryBlockIndex < Blockchain.height() ) {
    //         const queryBlock = Blockchain.getBlock(queryBlockIndex)
    //         response.blockAtHeight = { index: queryBlock.index, 
    //                                    hash: queryBlock.hash, 
    //                                    timestamp: queryBlock.timestamp }
    //     }
    //     return response
    // }

    // static pingResponseProcess( response ){
    //     if( response.error || response.result.length<1 )
    //         return { error: response.error || false} // nothing to process, maybe no nodes

    //     // review each response, add to peers table
    //     for( let node of response.result ){
    //         if( node.error ){
    //             const peer = this.peers[node.hostname]
    //             if( peer )
    //                 peer.pingError = (peer.pingError || 0) + 1
    //             // peer.pingNext = time() + peer.pingError * HEARTBEAT_INTERVAL // each error, spaces out next outreach attempt
    //         } else {
    //             // gather all self-reporting data from peer into peers object
    //             delete node.error
    //             delete node.peers
    //             this.peers[node.hostname] = { ...this.peers[node.hostname], ...node, pingError: 0 } // ...this.peers[peerIdx],
    //         }
    //     }
    // }



    // async broadcastPeers({ path, data = '', hosts }) {
    //     let broadcastPeers
    //     if( hosts === undefined || hosts.length < 1 ) // no hosts specified? >> blast everyone with transaction
    //         broadcastPeers = Object.keys(this.peers).filter( host => host !== this.hostname )
    //     else
    //         broadcastPeers = hosts.filter( host => host !== this.hostname ) //.filter( host => this.peers[host]?.dir === 'out' ) // only one ping direction

    //     // BUGBUG debug only block
    //     if( broadcastPeers.length>0 ){
    //         const color = path.includes('/node/announce') ? 'dim' : 'cyan'
    //         const pending = path.includes('/node/announce') ? ` pendingTransactions(${this.TransactionHandler.pendingCnt()})` : ''
    //         debug(color, `<< [${this.nodeName}]${path} [${this.nodeState}]${pending} @ (${broadcastPeers.join(',').replaceAll('http://localhost:','')})` )
    //     }

    //     const requests = broadcastPeers.map(async (host, idx) => {
    //         // the 'node'
    //         const request = { hostname: host, path, nodeToken: this.nodeName }
    //         if (data) request.body = data

    //         // try {
    //         const response = await urlCall(request)
    //         response.hostname = request.hostname
    //         if( response.error ){
    //             debug('dim',`   ! urlCall error: ${response.error}`)
    //             return response
    //         }

    //         // only deal with servers that are within 30 minutes of us
    //         if( Math.abs(response.timestamp - time()) > NODE_TIMESTAMP_TOLERANCE )
    //             return { ...response, error: 'Peers time unavailable of way off, ignoring!' }

    //         // in our peers object, track some stuff from the responding peer
    //         for( const key of ['nodeName','version','nodeState','type','startTime','timestamp','pendingTransactionsCnt','blockchainHeight'] )
    //             if( response[key] ) this.peers[host][key] = response[key]

    //         // if they have peers, let's add them & announce ourselves
    //         if( response.peers ){
    //             const newHosts = this.addPeerHosts( response.peers )
    //             if( newHosts.length > 0 )
    //                 this.broadcastPeers({ path: '/node/announce', hosts: newHosts, data: this.pingInfo(Blockchain.height()-1) })
    //                     .then( response => this.pingResponseProcess(response) )
    //         }
    //         return response
    //         // } catch(e) {
    //         //     debug('red',`   - Failed to connect host: ${request.hostname}`)
    //         //     return { error: `broadcast error; failed to connect ${request.hostname}` }
    //         // }

    //     })
    //     const result = (await Promise.all(requests)).filter(res => res !== null)
    //     return { error: false, result }
    // }

    // mining state machine
    static startMining() {
        let mineTransactions = []
        let rewardTransactions = []
        this.worker.status = 'READY'
        
        const workerMineQueued = () => {
        switch( this.worker.status ){
            case 'READY': {
                // clear queues
                rewardTransactions = []
                const blockIdx = this.Blockchain.height()
                this.Blockchain.calcMiningReward({ index: blockIdx })

                // gather transactions to mine, use ones staked by us
                mineTransactions = this.Mempool.getQueued({ miner: this.nodeName, maxTransactions: this.Blockchain.BLOCK_MAX_TRANSACTIONS })
                console.log( ` ready mineTransactions:!!`, mineTransactions)
                // min limit per block, have a kitkat, take a break!
                if( this.TransactionHandler.checkTransactionCount(mineTransactions).error ) break

                debug('cyan',`*** MINING START (${this.nodeName}) *** (difficulty: ${this.Blockchain.difficulty}) reward=${this.Blockchain.miningReward} mineTransactions=${mineTransactions.length}` )
                debug('dim')
                // prepare the mining fee transaction to accompany mineTransaction
                for( const t of mineTransactions ){
                    if( t.fee === 0 ) continue
                    const transactionData = { src: this.TransactionHandler.BASE_TOKEN, dest: this.nodeName, amount: t.fee, type: 'miningFees', source: t.hash, blockIdx }
                    const transaction = this.TransactionHandler.rewardTransaction(transactionData)
                    if( !transaction.error )
                        rewardTransactions.push( transaction )                        
                }

                // block mining reward
                if( this.Blockchain.miningReward>0 ) {
                    const transactionData = { src: this.TransactionHandler.BASE_TOKEN, dest: this.nodeName, amount: this.Blockchain.miningReward, type: 'miningReward', blockIdx }
                    const transaction = this.TransactionHandler.rewardTransaction(transactionData)
                    if( !transaction.error )
                        rewardTransactions.push( transaction )                        
                }

                debug('reset')

                // problems setting up rewardTransactions? ABORT!
                if( rewardTransactions.filter( t => t.error ).length > 0 ){
                    debug('dim',` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
                    this.worker.status = 'CLEANUP'
                    break
                }

                // Construct the block with the above transactions that we'll ATTEMPT to mine
                // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
                const newBlock = this.Blockchain.addBlock({ transactions: [ ...mineTransactions, ...rewardTransactions ] }, { prepareOnly: true })
                console.log( ` addBlock result: `, newBlock )
                if( newBlock.error ){
                    debug('dim',` ~ [Miner] addBlock failed; dropping it before re-attempting to mine. Error: ${newBlock.error}`)
                    if( newBlock.transaction?.hash ) // failed due to this particular transaction, so we will delete it and try again and try again
                        this.TransactionHandler.deleteBatch({ hashes: [ newBlock.transaction.hash ] })
                    this.worker.status = 'CLEANUP'
                    break
                }

                // offload to worker thread to solve (keeps system responsive, could allow pool of workers)
                this.worker.status = 'MINING'
                this.worker.startTime = time()
                this.worker.block = {}
                this.worker.node.postMessage({action: 'MINE', block: newBlock.block, difficulty: this.Blockchain.difficulty})
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
                this.P2P.setNodeState('ADD_CHAIN')
                const addResult = this.Blockchain.addChain([this.worker.block])
                const { error, hashes, transactionCnt, resetLedger, blocks }= addResult
                if( error ){
                    this.worker.status = 'CLEANUP'
                    break
                }
                this.P2P.setNodeState('ONLINE')
                debug('green',`SOLVED (in ${blocks[0].powTime}s) block: transactionCnt(${transactionCnt}) (hashes: ${hashes?.length}, resetLedger->`
                             +`${resetLedger ? 'Yes! *Problem*' : 'No? Good!'}); scanning pendingTransactions and removing any that were published in this block.` )

                // now remove them from pendingTransactions
                this.Mempool.deleteQueue( hashes )

                // tell everyone about block
                this.P2P.broadcastBlocks( [this.worker.block] )

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

                    const { error, pending }= this.TransactionHandler.clearBlockMempool(this.worker.block.transactions)
                    if( error ) debug('red', error)
                    debug('cyan',`    \ ${pending} transactions reset to pendingTransactions.`)
                }
                // TODO release stake claim on these?

                this.worker.status = 'READY'
                this.P2P.setNodeState('ONLINE')
                break
                }
            }
        } 
        
        // node must be online, and then mine if pending exist or if it's in not in idle mode (READY)
        setInterval(() => {
            console.log( ` mine check nodeState(${this.P2P.nodeState}) worker.status(${this.worker.status}) this.Mempool.queueLen(${this.Mempool.queueLen('miner',this.nodeName)})`)
            if (this.P2P.nodeState === 'ONLINE' && (this.worker.status !== 'READY' || this.Mempool.queueLen('miner',this.nodeName)) ){
                workerMineQueued()
            }
        }, MINE_INTERVAL * 1000); // Try to mine a new block every MINE_INTERVAL seconds
    }
}
