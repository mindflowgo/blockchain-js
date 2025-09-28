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

import TransactionHandler from './TransactionHandler.js'
import Blockchain from './Blockchain.js'
import Wallet from './Wallet.js'
import P2P from './P2P.js'
import Mempool from './Mempool.js'
import MinerWorker from './MinerWorker.js'

import { fixRounding, time, waitReady, debug } from './helper.js'

const MINER_VERSION = '1:1.1'

// from .env
const MINING_TRY_INTERVAL = process.env.MINING_TRY_INTERVAL    // how often to attempt to gather transactions to mine

// Miner Class =================================================================================
export default class Miner {
    
    constructor( nodeName, nodeType, host, port, peers, dataPath, walletFile ) {
        this.version = MINER_VERSION        // blockchain network : spec-version1.0
        this.nodeName = nodeName
        this.nodeType = nodeType              // ARCHIVE, LOOKUP (just enough for lookups), MINER
        this.startTime = time()
        this.dataPath = dataPath
        this.verbosity = 4 // 0 = none, 1 = major, 2 = more, 3 = all


        // initializes instances of these classes:
        // TransactionHandler; Mempool; Wallet; Blockchain; P2P
        // there are interdependencies between classes for services, so order specific

        // init transaction management system
        this.TransactionHandler = new TransactionHandler(this.nodeName)

        // the address wallets, create wallet for miner, reset balances (re-established as blockchain built)
        this.Wallet = new Wallet( walletFile, this.TransactionHandler )

        // start/load mempool
        this.Mempool = new Mempool( this.Wallet )

        // update these classes for this...
        this.TransactionHandler.setHelperClasses(this.Wallet,this.Mempool)

        // each node needs it's own wallet, for issuing own tokens (if needed), 
        this.Wallet.generate(nodeName)
        // we reset tokens because reloading will re-generate the balances
        this.Wallet.resetAllTokens()

        // init blockchain (load or create)
        // blockchain directly uses these classes
        this.Blockchain = new Blockchain( this.version, this.nodeName, this.dataPath, this.TransactionHandler, this.Mempool, this.Wallet )

        // init our this.P2P module
        this.P2P = new P2P( this.nodeName, host, port, peers, this.Blockchain, ()=>{return this.Mempool.Queue.length()} )
        
        debug( 3, 
            `\n\n== MINER ==========================================================`
            +`\n${this.nodeName} / ${this.version} Listening(${host}:${port}) Peers(${peers.join(' ').replaceAll(this.hostname,'').replaceAll('http://localhost','').trim()})`
            +`\nAddress: ${this.Wallet.getUserPublicKey(this.nodeName)}`
            +`\nBlock Height: ${this.Blockchain.height()}`
            +`\nWaiting some time before mining -> discovering peers...`
            // +`\nQueued get staled after ${Math.round(PENDING_TRANSACTION_STALE/6)/10} mins`
            +`\n== LEDGER =========================================================`)
        this.Wallet.balances()
        debug(`\n\n\n`)

        // Start mining Worker thread
        this.MinerWorker = new MinerWorker(this.nodeName, this.dataPath, ()=>{ return this.Blockchain.difficulty } )
        // this.startMinerWorker()

        // Run periodic mining attempt (that offloads task to worker)
        this.startMining()

    }

    prepareTransactionsForMining(blockIdx){
        let rewardTransactions = []

        // gather transactions to mine, use ones staked by us
        let mineTransactions = this.Mempool.Queue.getMinerSorted({ miner: this.nodeName, maxTransactions: this.Blockchain.BLOCK_MAX_TRANSACTIONS })
        // min limit per block, have a kitkat, take a break!
        if( this.TransactionHandler.checkTransactionCount(mineTransactions).error ) return []

        debug('cyan',`*** MINING START (${this.nodeName}) *** (difficulty: ${this.Blockchain.difficulty}) reward=${this.Blockchain.miningReward} mineTransactions=${mineTransactions.length}` )
        debug('dim')
        // prepare the mining fee transaction to accompany mineTransaction
        const BASE_TOKEN = this.TransactionHandler.BASE_TOKEN
        for( const t of mineTransactions ){
            if( t.fee === 0 ) continue
            const transactionData = { src: BASE_TOKEN, dest: this.nodeName, amount: t.fee, token: BASE_TOKEN, type: 'miningFees', source: t.hash }
            const transaction = this.TransactionHandler.rewardTransaction(transactionData, blockIdx)
            if( !transaction.error )
                rewardTransactions.push( transaction )                        
        }

        // block mining reward
        if( this.Blockchain.miningReward>0 ) {
            const transactionData = { src: BASE_TOKEN, dest: this.nodeName, amount: this.Blockchain.miningReward, token: BASE_TOKEN, type: 'miningReward' }
            const transaction = this.TransactionHandler.rewardTransaction(transactionData, blockIdx)
            if( !transaction.error )
                rewardTransactions.push( transaction )                        
        }

        debug('reset')

        // problems setting up rewardTransactions? ABORT!
        if( rewardTransactions.filter( t => t.error ).length > 0 ){
            debug('dim',` .. preparing mining, but problem with reward transaction: aborting!`, rewardTransactions )
            return []
        }

        return [ ...mineTransactions, ...rewardTransactions ]
    }

    // mining state machine
    // 1. start mining
    // 2. check status
    // 3. either: solved
    // 4          undo 
    async startMining() {
        // this.P2P.nodeState === 'ONLINE'

        // build the block to mine
        const blockIdx = this.Blockchain.height()
        this.Blockchain.calcMiningReward({ index: blockIdx })

        const transactions = this.prepareTransactionsForMining( blockIdx )
        if( transactions.length > 0 ) {
            
            // Construct the block with the above transactions that we'll ATTEMPT to mine
            // transaction as "n/unconfirmed" until the transaction is 6 blocks deep
            const blockData = this.Blockchain.prepareBlockData(transactions)

            // offload to worker thread to solve (keeps system responsive, could allow pool of workers)
            const mineResult = await this.MinerWorker.mineBlock( blockData )
        
            if( mineResult.action === 'DONE_SOLVED'  ) {
                // Worker thread should have solved, now 'this.workerBlock' has a full solution nonce
                this.P2P.setNodeState('ADD_BLOCK')
                const addResult = this.Blockchain.addBlock( mineResult.blockData )
                const { error, hashes, transactionCnt, resetLedger }= addResult
                if( !error ){
                    this.P2P.setNodeState('ONLINE')
                    debug('green',`SOLVED (in ${mineResult.elapsed}s) block: transactionCnt(${transactionCnt}) (hashes: ${hashes?.length}, resetLedger->`
                                +`${resetLedger ? 'Yes! *Problem*' : 'No? Good!'}); scanning pendingTransactions and removing any that were published in this block.` )

                    // tell everyone about block
                    this.P2P.broadcastBlock( mineResult.blockData )
                } else {
                    // BUGBUG to write. addblock failed, does it matter? maybe not here. maybe chk message
                    this.Blockchain.rollbackBlock( mineResult.blockData )    
                    //const { error, pending }= this.TransactionHandler.clearBlockMempool(this.MinerWorker.getMinedBlockTransactions())
                    this.P2P.setNodeState('ONLINE')
                }
            }
        }
        
        // waits a while after completing, and then looks for transactions and tries to mine them again
        setTimeout( ()=>{ this.startMining() }, MINING_TRY_INTERVAL * 1000 )
    }
}
