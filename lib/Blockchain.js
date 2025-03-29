/**************************************************************************
 * Simple Fully Functional Blockchain Example
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This is the blockchain class, so all methods and data here should be 
 * ONLY related to the relevant perspective and needs of the blockchain
 * class
 * ***********************************************************************/

import bs from 'bs58'
import Block from './Block.js'
import { urlCall, sha256Hash, fixRounding, time, debug } from './helper.js'

// preset characteristics of this blockchain
const GENESIS_ISSUE = 1000000000        // coin-pool size established at genesis
const MINING_REWARD = 100               // initial mining reward
const BLOCK_TIMESTAMP_TOLERANCE = 7200  // 30 mins, allow blocks to be off by up 2 hours
const BLOCK_MIN_TRANSACTIONS = 1
const BLOCK_MAX_TRANSACTIONS = 10
const BLOCK_TRANSACTION_TYPES = ['minerDeposit','transfer'] // valid user transaction types
const BLOCK_TRANSACTION_ADMIN_TYPES = ['mintIssue','mintAirDrop']
// admin types not adjustable: mintIssue, mintAirDrop, miningReward, miningFees

// Blockchain Class ==============================================================
export default class Blockchain {
    constructor({ nodeName, version, ledger, transactionManager, dataPath }) {
        this.nodeName = nodeName
        this.ledger = ledger
        this.version = version          // network id + protocol version
        this.miningReward = MINING_REWARD // adjusted each block addition
        this.difficulty = 1
        this.transactionManager = transactionManager
        this.transactionLimit = { min: BLOCK_MIN_TRANSACTIONS, max: BLOCK_MAX_TRANSACTIONS }
        this.dataPath = dataPath

        // our actual chain
        this.chain = [] 

        // pre-load only EXISTING blocks, and add to chain
        const blockData = { index: 0 }
        let block
        while( 1 ){
            const result = this.addBlock(blockData, { readOnly: true, txUpdate: true })
            if( result.error ){
                // problem adding this block, stop adding the chain, and print message (it will reload chain from another system)
                if( result.block ) debug('red', `\n` + result.error)
                break
            }
            block = result.block
            blockData.index++
        }

        // no existing blocks, create genesis
        if( blockData.index < 1 ){
            debug( `~~ No existing blockchain, creating genesis block that specifies the money supply available`)
            // for our tracking our genesis defines our mint supply (BTC doesn't do this, they simply "mint" with block creation)
            const genesisTransaction = this.transactionManager.new({ src: '_', dest: '_mint', amount: GENESIS_ISSUE, type: 'mintIssue', timestamp: 0 })
            const { error, hashes, transactionCnt } = this.addBlockchain([{ index: 0, minerName: 'genesis', version: '1.0', transactions: [ genesisTransaction ]}])
            if( error ){
                debug( 'red', `SERIOUS problem, unable to create genesis block. Check your filesystem.`)
                process.exit(-1)
            }
            // now remove that transaction from mempool as issued
            this.transactionManager.deletePending({ hashes })
            debug( `~~ Genesis created with ${transactionCnt} transactions; coin supply of ${GENESIS_ISSUE} available from the mint`)
        }
    }

    height() {
        return this.chain.length
    }


    getBlock(index=-1) {
        if( index < -1 || index >= this.height() ) return false
        return this.chain.at(index)
    }

    // not used, MinerWorker has it's own
    generateProofOfWork(block) {
        const start = time()

        const hashPrefix = '0'.repeat(this.difficulty)
        // find a hash that starts with some number of '0's, as per BTC paper
        while (!block.hash.startsWith(hashPrefix)) {
            block.nonce++
            block.hash = block.calcHash()
        }
        // track time to generate PoW (in seconds)
        block.powTime = time() - start
        return true
    }

    calcMiningReward({ index, update = true }){
        // Reward for mining a block, decreases with every 10 blocks minted (ex. for real BTC: 50 / 2**Math.floor(index/210000); reward halves every 210,000 blocks)
        // Freshly-mined coins cannot be spent until 100 blocks deep; this is HOW BTC is issued!
        const miningReward = fixRounding( 100 / 2**Math.floor(index/10) )

        // mining nonce difficulty increase every 10 blocks (real BTC: every 2016 blocks to maintain block time of 10 minutes)
        // BUGBUG  TODO for our testing never want difficulty to exceed 6 else miing takes too long
        const difficulty = Math.min( 2 + Math.floor(index/10), 5 )

        if( update ){
            this.miningReward = miningReward
            this.difficulty = difficulty
        }
        return { miningReward, difficulty }
    }

    // build Merkle using base58 entries
    merkleBuild(transactions) {
        if (transactions.length === 0) return 0

        let layers = []
        layers.push(transactions.map(t => t.hash))

        // Step 2: Build the tree upwards
        while (layers[layers.length - 1].length > 1) {
            let currentLevel = layers[layers.length - 1]
            // If odd number of elements, repeat/duplicate last
            if (currentLevel.length % 2 === 1) 
                currentLevel.push(currentLevel[currentLevel.length - 1])

            let newLevel = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                // have a consistent way of arranging the 2 numbers, ex. smaller first else use symmetric hash
                const a = bs.decode(currentLevel[i])
                const b = bs.decode(currentLevel[i + 1])
                const aLessB = Buffer.compare(a, b)
                newLevel.push( bs.encode( sha256Hash(aLessB>=0 ? a + b : b + a)) )
            }

            layers.push(newLevel)
        }
        return layers
    }

    // Generate the Merkle Proof for a specific transaction
    // Verify in ledger.js
    merkleProof(transactions, txHash) {
        const tree = this.merkleBuild(transactions)
        const txHashList = tree[0] 
        let index = txHashList.indexOf(txHash)
        if (index === -1)
            return { error: `Transaction NOT found in block. Aborting.` }

        let proof = []
        for (let level = 0; level < tree.length - 1; level++) {
            const siblingIndex = index % 2 === 0 ? index + 1 : index - 1

            if (siblingIndex < tree[level].length) 
                proof.push(tree[level][siblingIndex])

            index = Math.floor(index / 2) // Move up
        }
        const [ merkleRoot ]= tree.pop() //last entry
        return { proof, merkleRoot } //: tree[tree.length - 1][0]
    }

    addBlock(blockData, options = {}){ 
        const { prepareOnly = false, readOnly = false, forceOverwrite = false, txUpdate = false,
                nodeName = this.nodeName, dataPath = this.dataPath } = options

        const index = this.height()
        if( blockData.index && blockData.index !== index ){
            // if adding it MUST be sequentially AFTER last block
            // debug( `x [addBlock] New block must be index+1 on last block, or empty index for us to fill in; block: `, blockData )
            return { error: `Attempted adding new block (addBlock) but new block index=${blockData.index}), accepting index=${index} now (or empty index). Rejecting.` }
        }

        // set index, in case we are reading a prior block on filesystem
        blockData.index = index

        // if mining (prepareOnly), we MUST be owner of block
        if( prepareOnly ){
            if( !blockData?.transactions || blockData.transactions.length < this.transactionLimit.min ) 
                return { error: `Need min ${this.transactionLimit.min} transactions per block; there are ${blockData.transactions.length} in this block. Rejecting.` }
            
            blockData.prevHash = this.getBlock(index-1).hash // get the hash from previous block
            blockData.minerName = this.nodeName
            blockData.version = this.version // version of block
            // build merkle tree, grab the root value
            const merkleTree = this.merkleBuild( blockData.transactions )
            blockData.merkleRoot = merkleTree.pop()[0]
        }

        // remove meta-data from block
        if( blockData.transactions )
            blockData.transactions = blockData.transactions.map( ({meta, ...data})=> data )
        // assemble block
        const newBlock = new Block(blockData, { nodeName, dataPath, forceOverwrite })
        if( newBlock.error ) return newBlock

        // a block already existing will have a fileCache entry; if we readOnly, this MUST exist as don't want to create new
        if( readOnly && !newBlock.fileCache){
            // debug( `x read-only mode but no pre-existing could be loaded for index(${index}), rejecting adding.` )
            return { error: `Read-Only mode BUT *NO* pre-existing could be loaded for index(${index}), aborting.` }
        }

        if( prepareOnly ){
            // prepareOnly means it wants the structure of the block -> gives to MinerWorker
            return { error: false, block: newBlock }
        }
        
        // Audit this block to make sure it will pass being added to chain
        const auditResult = this.auditBlockValid( newBlock )
        if( auditResult.error ){
            debug('red',`[addBlock] auditBlockValid FAILED on #${index}: ${auditResult.error}`)
            return { ...auditResult, block: newBlock }
        } 

        if( forceOverwrite || !newBlock.fileCache ) // no cache file, so it's a new block, write it
            newBlock.writeFile(forceOverwrite)
        
        // now sync up the transactions in this block
        const syncResult = this.transactionManager.newBatch( newBlock.transactions, { blockIdx: newBlock.index, txUpdate: true })
        if( syncResult.error ) return syncResult

        const { hashes, newHashes }= syncResult
        const { transactionCnt, adminCnt, miningFees }= auditResult
        debug('cyan', `  > block #${newBlock.index} ready: imported${transactionCnt>0 ? ` +${transactionCnt} user-transactions` : '' } ${adminCnt>0 ? ` +${adminCnt} admin-transactions` : '' }${miningFees>0 ? `; $${miningFees} mining fees` : ''} ${ forceOverwrite || !newBlock.fileCache ? ` [wrote file]` : ''} `)

        // finally, add it to the blockchain!
        this.chain.push(newBlock)
        // update height for ledger to know
        this.ledger.maxBlockIdx = newBlock.index

        // update mining rewards info
        this.calcMiningReward({ index: this.chain.length })

        return { error: false, block: newBlock, hashes, newHashes, transactionCnt, adminCnt, miningFees }
    }

    auditBlockValid( block ){
        const index = block.index
        if (block.hash !== block.calcHash()) {
            debug('red', `Current block #${index} hash(${block.hash}) is different from calcHash()(${block.calcHash()}), rejecting!`);
            // debug( block )
            return { error: `Current block hash is invalid, rejecting.`, index }
        }

        // determine the reward, for place of current block (don't update block settings though)
        const calc = this.calcMiningReward({ index, update: false })

        if (index > 0) {
            const prevHash = this.getBlock(block.index - 1).hash
            if (block.prevHash !== prevHash) {
                debug('red',`Block#${block.index} block.prevHash(${block.prevHash}) doesn't match passed-in prevHash(${prevHash}), rejecting!`)
                return { error: `Previous block hash does not match, so it's not next in chain, rejecting.`, index }
            }

            // Check block timestamp is basically valid (within a window, ex 2 hours ) 
            // average last 3 blocks for the timestamp
            const prevTimestamp = this.height()<10 ? this.getBlock(block.index - 1).timestamp 
                : Math.floor((this.getBlock(block.index - 1).timestamp + 
                              this.getBlock(block.index - 2).timestamp + 
                              this.getBlock(block.index - 3).timestamp)/3)
            if (block.timestamp <= (prevTimestamp - BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${block.index} timestamp (${block.timestamp}) is before or equal to previous 3-block average (${prevTimestamp} + ${BLOCK_TIMESTAMP_TOLERANCE})` )
                return { error: 'Invalid block timestamp: Must be after previous block' }
            }
            if (block.timestamp > (time() + BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${block.index} timestamp (${block.timestamp}) is too far in the future`)
                return { error: 'Invalid block timestamp: Too far in the future' }
            }
        
            // check PoW valid
            const hashPrefix = '0'.repeat(calc.difficulty)
            if( !block.hash.startsWith(hashPrefix) || block.hash.startsWith(hashPrefix+'0') ){
                debug('red',`Block#${block.index}: Invalid hash (${block.hash}), first ${calc.difficulty}-bytes must be 0 - hash (${block.hash}), rejecting!`)
                return { error: `Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`, index }
            }
        }

        // check transactions are all signed, and seq ok
        let miningReward = 0, miningFees = 0, transactionCnt = 0, adminCnt = 0, transactionError = false
        const blockMiner = block.minerName

        // gather all wallets as we're doing a dry run through transactions
        const walletKeys = {}
        block.transactions.forEach( t =>{ walletKeys[t.src] = 1; walletKeys[t.dest] = 1; })
        this.ledger.walletSnapshots( Object.keys(walletKeys) )
        debug('dim',`-- wallet snapshot --\\\\`)
        this.ledger.debugOutputLevel = 0 // don's show output while usingit
 
        for( const transaction of block.transactions ){
            // check transaction itself (signing, balances) by doing it
            const result = this.ledger.transaction(transaction,{ blockIdx: block.index, txUpdate: true })
            if( result.error ) transactionError = result.error

            // check integrity of block structure - return error if not specific allowed types
            if( transaction.type === 'miningReward' ){
                // one mining reward per block
                if( transaction.dest.startsWith(blockMiner+':') && transaction.amount == calc.miningReward && miningReward < 2 ){
                    miningReward++
                    miningFees += transaction.amount
                } else
                    transactionError = `Block miningReward illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}) for amount(${transaction.amount}). Rejecting.`

            } else if( transaction.type === 'miningFees' ){
                // each mining fee must corespond to a signed transaction, the actual value depends what user signed-off to
                const matchingTransaction = block.transactions.filter( t => t.hash === transaction.source )
                if( transaction.dest.startsWith(blockMiner+':') && matchingTransaction.length === 1 &&
                    matchingTransaction[0].txSig.length > 10 && matchingTransaction[0].fee == transaction.amount )
                    miningFees += transaction.amount
                else
                    transactionError = `Block miningFees illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}) for amount(${transaction.amount}). Rejecting.`

            } else if( transaction.type === 'mintIssue' ){
                adminCnt++
                // mint issue normally only genesis block; unless increasing supply
                // TODO do we allow outside genesis? && index === 0 ?
                debug('cyan',`  ~ Note: admin-level mintIssue transaction detected` )
            } else if( transaction.type === 'mintAirDrop' ){
                adminCnt++
                // should probe back to core system if sanctioned, and what server
                debug('cyan',`  ~ Note: admin-level mintAirDrop transaction detected: ${transaction.amount} >> ${transaction.dest}` )
            } else if( BLOCK_TRANSACTION_TYPES.includes(transaction.type )){
                transactionCnt++

            } else {
                debug('red',`  ! transaction #${transaction.hash} txSig(${transaction.txSig}) type(${transaction.type}) INVALID.` )
                transactionError = `Block audit failed: hash(${transaction.hash} txSig(${transaction.txSig}) type(${transaction.type}) INVALID`
            }

            if( transactionError ){ // capture the transaction making the error, exit loop
                transactionError = { error: transactionError, transaction }
                break
            }
        }

        this.ledger.walletRestores( Object.keys(walletKeys) )
        this.ledger.debugOutputLevel = 1
        debug('dim',`-- wallet restore --//`)
        // an object with transaction error will be returned, else simply false
        if( transactionError ) return transactionError
        
        // limit structure of block (need min X transactions, etc)
        // if( index>1 && transactionCnt<10 )
        //     return { error: `Each block needs minimum 10 transactions`, transactionCnt}

        return { error: false, transactionCnt, adminCnt, miningFees: fixRounding(miningFees) }
    }

    auditChainValid( chain = this.chain ) {
        // scan chain from index=0 onward checking chained hashes
        for (let i = 0; i < chain.length; i++) {
            const block = chain[i]
            if( block.index != i ) {
                debug('red', `Current block index(${block.index}) wrong for position(${i}), rejecting!`)
                return { error: `Current block index(${block.index}) wrong for position(${i}), rejecting.` }
            }

            const result = this.auditBlockValid( block )
            if( result.error ) return result
        }
        return true;
    }
       
    getBlockchain(fromIndex=0,size=0,fields='') {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let result = []
        if( fields === 'hashes')
            result = [ ...chain.map( ({index, hash}) =>{ return {index, hash} })]
        else if( fields === 'meta')
            result = [ ...chain.map( ({index, minerName, timestamp, nodeName, dataPath, powTime}) =>
                        { return {index, minerName, timestamp, nodeName, dataPath, powTime}} )]
        else
            // peel off meta-data in block before passing on all block-only data
            result = [ ...chain.map( ({nodeName, dataPath, powTime, ...data}) => data )]
        return result
    }

    addBlockchain(chain, blockOptions = {}){
        const { readOnly = false, forceOverwrite = false } = blockOptions
 
        let addBlockCnt = 0, hashes = [], newHashes = [], transactionCnt = 0, adminCnt = 0, miningFees = 0
        const fromIndex = chain[0].index

        // if our chain is longer, we extract our minted transactions > pending; then CUT CHAIN SHORT + add external blocks
        let resetLedger = false
        if( forceOverwrite && this.height() > fromIndex ){
            const chainExcessBlocks = this.height() - fromIndex
            // quickly repush these onto the pending to try re-publishing
            const dropChain = this.chain.slice(fromIndex, this.height())
            let blockIdx = fromIndex
            const preserveTransactionTypes = [...BLOCK_TRANSACTION_ADMIN_TYPES, ...BLOCK_TRANSACTION_TYPES]
            for( const block of dropChain ){
                if( block.minerName !== this.nodeName ) continue

                for( const transaction of block.transactions ){
                    if( !preserveTransactionTypes.includes(transaction.type) ) continue // only user-transactions + airdrops/issuing
                    transaction.meta = { miner: this.nodeName, minerReAdded: time() }
                    // re-add to pending
                    const existsPending = this.transactionManager.existsPending( transaction.hash )
                    debug('dim',`    -> +re-saving to pending:    ${transaction.src.split(':')[0]}/${transaction.seq} -> ${transaction.dest.split(':')[0]} $${transaction.amount}` + (existsPending ? `; hash:${transaction.hash} already pending, skipping re-adding` : ''))
                    if( existsPending ) // BUGBUG show pending that created this error
                        console.log( this.transactionManager.pending, this.transactionManager.hashes )
                    if( !existsPending )
                        this.transactionManager.addPending( transaction )
                }
            }
            debug( `    ~ re-added dropped-chain transactions from this server to pending; shortening blockchain by ${chainExcessBlocks}`)
            this.chain = this.chain.slice(0, -chainExcessBlocks)

            // go through rebuilding the transactions to that point
            debug( `    ~ clearing and re-calcing wallet balances (optimize?)`)
            debug( 'dim' )
            this.ledger.reset()
            resetLedger = true
            this.transactionManager.hashes = {} 
            for( const block of this.chain ){
                let syncResult = this.transactionManager.newBatch( block.transactions, { blockIdx: block.index, txUpdate: true })
                if( syncResult.error ) return syncResult
            }
            debug( 'reset' )
        }

        let blocks = []
        for( const blockData of chain ){
            const addResult = this.addBlock(blockData, { ...blockOptions, txUpdate: true })
            // if( addResult.error ) debug( 'red', `[addBlockchain]   ! error #${blockData.index} > `, addResult )
            if( addResult.error ) return addResult

            blocks.push(addResult.block)
            hashes = hashes.concat(addResult.hashes)
            newHashes = newHashes.concat(addResult.newHashes)
            transactionCnt += addResult.transactionCnt
            adminCnt += addResult.adminCnt
            miningFees += addResult.miningFees
            addBlockCnt++
        }

        debug( ` - added ${addBlockCnt} blocks, new re-tabulating ledger.`)
        // remove any pending that exist in these processed blocks
        this.transactionManager.deletePending({ hashes })
        
        // BUGBUG remove, just shows balances for debugging purposes
        debug( `\n\n== LEDGER =========================================================`)
        this.ledger.walletBalances()

        return { error: false, blocks, hashes, newHashes, addBlockCnt, transactionCnt, adminCnt, miningFees, resetLedger }
    }
}