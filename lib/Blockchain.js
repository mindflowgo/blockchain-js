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
const MIN_TRANSACTIONS_PER_BLOCK = 1    // don't create a block with less than this may transactions (excluding miningFees/Rewards)
const MAX_TRANSACTIONS_PER_BLOCK = 10   // don't create a block with more than this many transactions (excluding miningFees/Rewards)
const MINING_REWARD = 100               // initial mining reward
const TRANSACTION_FEE = 0.01            // 1%
const TRANSACTION_FEE_MAX = 0           // most to charge
const BLOCK_TIMESTAMP_TOLERANCE = 7200  // 30 mins, allow blocks to be off by up 2 hours
const BLOCK_TRANSACTION_TYPES = ['minerDeposit','transfer'] // valid user transaction types
// admin types not adjustable: mintIssue, mintAirDrop, miningReward, miningFees

// Blockchain Class ==============================================================
export default class Blockchain {
    constructor({ nodeName, version, ledger, dataPath }) {
        this.nodeName = nodeName
        this.ledger = ledger
        this.version = version          // network id + protocol version
        this.miningReward = MINING_REWARD // adjusted each block addition
        this.difficulty = 1
        this.transactionsPerBlock = { min: MIN_TRANSACTIONS_PER_BLOCK, max: MAX_TRANSACTIONS_PER_BLOCK }
        this.transactionFee = TRANSACTION_FEE // each transaction incurs a min fee to miner (higher fee can mean faster minting in life, we simplify to flat)
        this.transactionFeeMax = TRANSACTION_FEE_MAX // max fee per transaction
        this.compress = false           // compress the blocks write data
        this.dataPath = dataPath

        // our actual chain
        this.chain = [] 

        // transaction list
        this.transactionHashes = []

        // pre-load only EXISTING blocks, and add to chain
        const blockData = { index: 0 }
        let block
        do {
            const result = this.addBlock(blockData, { readOnly: true, txUpdate: true })
            block = result.block
            // if( result.error && block.fileCache ) block.deleteFile() // invalid next block, erase it to re-sync proper one
            blockData.index++
        } while( block?.fileCache )

        // no existing blocks, create genesis
        if( blockData.index < 2 ){
            debug( `~~ No existing blockchain, starting with genesis block that specifies the money supply available`)
            // for our tracking we create a mint supply, BTC doesn't do this housekeeping
            const genesisTransaction = this.transaction({ src: '_', dest: '_mint', amount: GENESIS_ISSUE, type: 'mintIssue', timestamp: 0 })
            console.log( `transactionsHash:`, { ...this.transactionsHash } )
            const result = this.addBlock({ index: 0, transactions: [ genesisTransaction ]}, { txUpdate: true })
            console.log( `transactionsHash (after addBlock):`, {...this.transactionsHash })
            if( result.error ){
                debug( 'red', `SERIOUS problem, unable to create genesis block. Check your filesystem.`)
                process.exit(-1)
            }
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

    calcMiningReward(index){
        // Reward for mining a block, decreases with every 10 blocks minted (ex. for real BTC: 50 / 2**Math.floor(index/210000); reward halves every 210,000 blocks)
        // Freshly-mined coins cannot be spent until 100 blocks deep; this is HOW BTC is issued!
        const miningReward = fixRounding( 100 / 2**Math.floor(index/10) )

        // mining nonce difficulty increase every 10 blocks (real BTC: every 2016 blocks to maintain block time of 10 minutes)
        // BUGBUG  TODO for our testing never want difficulty to exceed 6 else miing takes too long
        const difficulty = Math.min( 2 + Math.floor(index/10), 5 )

        return { miningReward, difficulty }
    }

    // build Merkle using base58 entries
    merkleBuild(transactions) {
        if (transactions.length === 0) return 0

        let layers = []
        layers.push(transactions.map(tx => tx.hash))

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
                compress = this.compress, nodeName = this.nodeName, dataPath = this.dataPath } = options

        const index = this.height()
        if( blockData.index && blockData.index !== index ){
            // if adding it MUST be sequentially AFTER last block
            // debug( `x [addBlock] New block must be index+1 on last block, or empty index for us to fill in; block: `, blockData )
            return { error: `Attempted adding new block (addBlock) but new block index=${blockData.index}), accepting index=${index} now (or empty index). Rejecting.`, block: {} }
        }

        // build the block structure
        blockData.index = index
        blockData.prevHash = index>0 ? this.chain[index-1].hash : '0' // get the hash from last
        // if mining, we MUST be owner of block
        if( prepareOnly || !blockData.minerName ){
            blockData.minerName = this.nodeName
            blockData.version = this.version // version of block
        }

        const newBlock = new Block(blockData, { nodeName, compress, dataPath, forceOverwrite })

        // a block already existing will have a fileCache entry; if we readOnly, this MUST exist as don't want to create new
        if( readOnly && !newBlock.fileCache){
            // debug( `x read-only mode but no pre-existing could be loaded for index(${index}), rejecting adding.` )
            return { error: `read-only mode but NO pre-existing could be loaded for index(${index}), rejecting adding.`, block: {} }
        }

        if( prepareOnly ){
            // prepareOnly means it wants the structure of the block -> gives to MinerWorker
            console.log( '[addBlock] prepare-only: ', newBlock )
            return { error: false, block: newBlock }
        }
        
        // Audit this block to make sure it will pass being added to chain
        const auditResult = this.auditBlockValid( newBlock, true )
        if( auditResult.error ){
            debug('red',`[addBlock] auditBlockValid FAILED on #${index}: ${auditResult.error}`)
            return { ...auditResult, block: newBlock }
        } 

        if( forceOverwrite || !newBlock.fileCache ) // no cache file, so it's a new block, write it
            newBlock.writeFile(forceOverwrite)
        
        // now sync up the transactions for this block
        const syncResult = this.syncBlockTransactions( newBlock, txUpdate )
        if( syncResult.error ) return syncResult

        const { hashes, newHashes }= syncResult
        const { transactionCnt, adminCnt, miningFees }= auditResult
        debug('cyan', `  > block #${newBlock.index} ready: imported${transactionCnt>0 ? ` +${transactionCnt} user-transactions` : '' } ${adminCnt>0 ? ` +${adminCnt} admin-transactions` : '' }${miningFees>0 ? `; $${miningFees} mining fees` : ''} ${ forceOverwrite || !newBlock.fileCache ? ` [wrote file]` : ''} `)

        // finally, add it to the blockchain!
        this.chain.push(newBlock)

        // update mining rewards info
        const calc = this.calcMiningReward(this.chain.length)
        this.miningReward = calc.miningReward
        this.difficulty = calc.difficulty

        return { error: false, block: newBlock, hashes, newHashes, transactionCnt, adminCnt, miningFees }
    }

    auditBlockValid( currentBlock, blockIsNew = false ){
        const index = currentBlock.index
        const fileCache = currentBlock.fileCache
        if (currentBlock.hash !== currentBlock.calcHash()) {
            debug('red', `Current block #${index} hash(${currentBlock.hash}) is different from calcHash()(${currentBlock.calcHash()}), rejecting!`);
            // debug( currentBlock )
            return { error: `Current block hash is invalid, rejecting.`, index, fileCache }
        }

        // determine the reward, for place of current block
        const calc = this.calcMiningReward(index)

        if (index > 0) {
            const prevHash = this.getBlock(currentBlock.index - 1).hash
            if (currentBlock.prevHash !== prevHash) {
                debug('red',`Block#${currentBlock.index} currentBlock.prevHash(${currentBlock.prevHash}) doesn't match passed-in prevHash(${prevHash}), rejecting!`)
                return { error: `Previous block hash does not match, so it's not next in chain, rejecting.`, index, fileCache }
            }

            // Check block timestamp is basically valid (within a window, ex 2 hours ) 
            // average last 3 blocks for the timestamp
            const prevTimestamp = this.height()<10 ? this.getBlock(currentBlock.index - 1).timestamp 
                : Math.floor((this.getBlock(currentBlock.index - 1).timestamp + 
                              this.getBlock(currentBlock.index - 2).timestamp + 
                              this.getBlock(currentBlock.index - 3).timestamp)/3)
            if (currentBlock.timestamp <= (prevTimestamp - BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${currentBlock.index} timestamp (${currentBlock.timestamp}) is before or equal to previous 3-block average (${prevTimestamp} + ${BLOCK_TIMESTAMP_TOLERANCE})` )
                return { error: 'Invalid block timestamp: Must be after previous block' }
            }
            if (currentBlock.timestamp > (time() + BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${currentBlock.index} timestamp (${currentBlock.timestamp}) is too far in the future`)
                return { error: 'Invalid block timestamp: Too far in the future' }
            }
        
            // check PoW valid
            const hashPrefix = '0'.repeat(calc.difficulty)
            if( !currentBlock.hash.startsWith(hashPrefix) ){
                debug('red',`Block#${currentBlock.index}: Invalid hash (${currentBlock.hash}), first ${calc.difficulty}-bytes must be 0, rejecting!`, currentBlock)
                return { error: `Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`, index, fileCache }
            }
        }

        // check transactions are all signed, and seq ok
        let miningReward = 0, miningFees = 0, transactionCnt = 0, adminCnt = 0, transactionError = false
        const blockMiner = currentBlock.minerName

        // gather all wallets as we're doing a dry run through transactions
        const walletKeys = {}
        currentBlock.transactions.forEach( t =>{ walletKeys[t.src] = 1; walletKeys[t.dest] = 1; })
        this.ledger.walletSnapshots( Object.keys(walletKeys) )
        debug('dim',`-- wallet snapshot --\\\\`)
        this.ledger.debugOutputLevel = 0 // don's show output while usingit
 
        for( const transaction of currentBlock.transactions ){
            // check transaction itself (signing, balances) by doing it
            const transResult = this.ledger.transaction(transaction,{ blockIdx: currentBlock.index, blockIsNew, txUpdate: true })
            if( transResult.error ) transactionError = transResult.error

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
                const matchingTransaction = currentBlock.transactions.filter( t => t.hash === transaction.source )
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
            const currentBlock = chain[i]
            if( currentBlock.index != i ) {
                debug('red', `Current block index(${currentBlock.index}) wrong for position(${i}), rejecting!`)
                return { error: `Current block index(${currentBlock.index}) wrong for position(${i}), rejecting.` }
            }

            const result = this.auditBlockValid(currentBlock)
            if( result.error ) return result
        }
        return true;
    }
   
    findOrCreateHash( hash, blockIdx=-1 ){
        // no hash means it MUST be new
        if( !hash || hash.length<43 ) return { isNew: true, index: -1 }

        const isNew = this.transactionHashes[hash] === undefined
        
        if( isNew ) // create entry (-1 = pending, no assigned block)
            this.transactionHashes[hash] = { index: blockIdx, created: time() }

        const trans = this.transactionHashes[hash]

        if( !isNew && blockIdx > -1 ){
            if( trans.index === -1 ){
                // converting from pending (-1) to block #
                trans.index = blockIdx
            } else if( trans.index !== blockIdx ){
                debug( 'red', `**STRANGE** Two transactions with same hashes: blockIdx(${blockIdx}) but hash has: #${trans.index} `)
                // trans.index += ',' + blockIdx
                return { error: `Attempting to create same hash with different block, not allowed`}
            }
        }
        return { isNew, index: trans.index }
    }

    // add the layer of tracking blockchain transactions + HashTracker
    transaction(data, options = {}) {
        const { blockIdx = -1, txUpdate = false }= options

        const { error, isNew, index }= this.findOrCreateHash( data.hash, blockIdx )
        if( error ) return error

        let transaction
        if( isNew ){
            transaction = this.ledger.transaction(data, { blockIdx, txUpdate })
            if( transaction.error ){
                transaction = { error: transaction.error, index }
            } else {
                // create an entry for this with the actual hash
                if( !data.hash ){
                    const { error } = this.findOrCreateHash( transaction.hash, blockIdx )
                    if( error ) return error
                }
                if( data.hash === transaction.hash )
                    debug('dim',`     \\ new, with hash, processed ledger transaction`)
                else
                    debug('dim',`     \\ new, without hash, processed ledger transaction; created hash`)
            }
        } else if( index > -1 ){
            // not new, so likely was a mempool, now converted to a block entry
            transaction = { error: `No new transaction: updated wallet.onChain & transactionHash: block = #${index}${data.seq > 0 ? `; onChain(${data.seq})` : '' }`, updateSeq: true, index }
            const { src, dest, amount, fee, seq }= data
            
            // reflect onChain block-transaction data to include this as it's graduated
            // ***************** re-think
            this.ledger.transactionWalletUpdate({ src, dest, amount, fee, seq, blockIdx })
            // debug( `     . not new; ledger already reflects transaction, updated block#(${index}) in transactionHash `)
        } else {
            debug( 'red', `[blockchain::transaction] Should NOT come here: hash(${data.hash} blockIdx(${blockIdx}))`)
            transaction = { error: `Should NOT come here: hash(${data.hash} blockIdx(${blockIdx})`, index }
        }

        return transaction
    }

    transactionReverse({src, amount, fee, ...data}, options = {}) {
        const { blockIdx = -1, clearPending = false } = options

        const srcWallet = this.ledger.getWallet(src)
        if (srcWallet.error) return srcWallet // error return it

        // backtrack on their wallet seq -- figure out what it should be after this reverse
        // if a BLOCK IDX given, that means we find previous block in history and get its max
        // debug( `[transactionReverse] tx.sex(${srcWallet.tx.seq}) bockSeq.seq(${srcWallet.onChain.seq})`)
        if (blockIdx > -1 ) { // && srcWallet.onChain.historyIdx.length > 0) {
            srcWallet.onChain.seq--
            debug('dim', `   [transactionReverse] ----> onChain.seq(${srcWallet.onChain.seq})`)
        } else {
            srcWallet.seq--
            debug('dim', `   [transactionReverse] ----> seq(${srcWallet.seq})`)
        }
            // const currentPos = srcWallet.onChain.historyIdx.indexOf(blockIdx)
            // if (currentPos !== -1) {
            //     // Remove the current block from history
            //     srcWallet.onChain.historyIdx.splice(currentPos, 1)
                
            //     // Get the previous block's index (if any)
            //     const priorSrcBlockIdx = currentPos > 0 ? 
            //         srcWallet.onChain.historyIdx[currentPos - 1] : 
            //         srcWallet.onChain.historyIdx[0]

            //     if (priorSrcBlockIdx !== undefined) {
            //         const block = this.getBlock(priorSrcBlockIdx)
            //         // Get transactions for this source in the prior block
            //         const srcTransactions = block.transactions
            //             .filter(t => t.src === src)
            //             .sort((a, b) => a.seq - b.seq)
                    
            //         // Use the last sequential transaction's sequence number
            //         if (srcTransactions.length > 0) {
            //             const seq = srcTransactions[srcTransactions.length - 1].seq
            //             debug('dim', `   ----> Reverting to seq ${seq} from block ${priorSrcBlockIdx}`)
            //             srcWallet.onChain.seq = seq
            //             srcWallet.tx.seq = seq
            //         }
            //     } else {
            //         // No prior blocks, reset sequence to 0
            //         debug('dim', `   ----> No prior blocks, resetting sequence to 0`)
            //         srcWallet.onChain.seq = 0
            //         srcWallet.tx.seq = 0
            //     }
        //     }
        // }

        // if in pendingTransaction, leave it, else erase it
        // reverse transaction tx in wallet, and if blockidx present, also reverse onChain in wallet too
        const reverseTransaction = this.ledger.transactionReverse({src, amount, fee, ...data}, { blockIdx, txUpdate: true })
        
        // this ONLY happens when forced, else normally hash stays as pending stays
        if (clearPending && !reverseTransaction.error) {
            delete this.transactionHashes[data.hash]
        }

        return reverseTransaction
    }

    syncBlockTransactions( block, txUpdate = false ){
        // run ledger transaction & add to hash list
        let newHashes = [], hashes = [], error = '', transactionCnt = 0
        const addTransaction = ( t ) => {
            debug('green',`[syncBlockTransacstions] block#${block.index}`)
            const transaction = this.transaction(t, { blockIdx: block.index, txUpdate })
            hashes.push( t.hash )
            transactionCnt++
            if( transaction.error ){
                if( transaction?.index<0 ){
                    // failed so delete reference to this transaction hash
                    debug( 'red', ` .. transaction REAL error (${transaction.error}), deleting from transactionHashes[]`)
                    delete this.transactionHashes[t.hash]
                    hashes.pop() // slice(0,-1)
                    transactionCnt--
                    error += transaction.error + ','
                } else {
                    debug( `..${transaction.error}`)
                }
            } else {
                // debug( ` .. [syncBlockTransactions] (${t.hash}, ${blockIdx}) -> #${transaction?.index||'NEW'}`)
                // debug( ` added new transaction (${transactionCnt})`)
                newHashes.push( transaction.hash )
            }
            return { error, transactionCnt, hashes, newHashes }
        }
        
        debug('cyan',`\n- [block#${block.index}]: (transactions: ${block.transactions.length}) ------------------------------------------------------------------------` )
        debug('dim')
        block.transactions.forEach( t => addTransaction(t) )
        debug('reset')
        return { error: false, transactionCnt, hashes, newHashes }
    }
    
    getBlockchainHashes(fromIndex=0,size=0) {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let hashes = []
        for( const block of chain )
            hashes.push({ index: block.index, hash: block.hash })
        return hashes
    }
    
    getBlockchain(fromIndex=0,size=0) {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let blocks = []
        for( const blockInfo of chain ){
            // delete meta-data in block before passing on
            const { fileCache, nodeName, compress, dataPath, ...block }= blockInfo
            blocks.push( block )
        }
        // // delete on-server attributes, not relevant for others (and doesn't affect hash)
        // chain.forEach( block =>{ delete block.fileCache; delete block.nodeName; delete block.compress; delete block.dataPath; })
        // return chain
        return blocks
    }

    addBlockchain(chain, blockOptions = {}){
        const { readOnly = false, forceOverwrite = false } = blockOptions
 
        let addBlockCnt = 0, hashes = [], newHashes = [], transactionCnt = 0, adminCnt = 0, miningFees = 0
        const fromIndex = chain[0].index

        // if our chain is longer, we have to shorten to allow chronological order
        let resetLedger = false
        if( forceOverwrite && this.height() > fromIndex ){
            const chainExcessBlocks = this.height() - fromIndex
            debug( `    ~ shortening blockchain by ${chainExcessBlocks}`)
            this.chain = this.chain.slice(0, -chainExcessBlocks)

            // go through rebuilding the transactions to that point
            debug( `    ~ clearing and re-calcing wallet balances (optimize?)`)
            debug( 'dim' )
            this.ledger.reset()
            resetLedger = true
            this.transactionHashes = []
            for( const block of this.chain ){
                let syncResult = this.syncBlockTransactions( block, true )
                if( syncResult.error ) return syncResult
            }
            debug( 'reset' )
        }

        let blocks = []
        for( const blockData of chain ){
            const addResult = this.addBlock(blockData, { ...blockOptions, txUpdate: true })
            if( addResult.error ) debug( 'red', `[addBlockchain]   ! error #${blockData.index} > `, addResult )
            if( addResult.error ) return addResult

            blocks.push(addResult.block)
            hashes = hashes.concat(addResult.hashes)
            newHashes = newHashes.concat(addResult.newHashes)
            transactionCnt += addResult.transactionCnt
            adminCnt += addResult.adminCnt
            miningFees += addResult.miningFees
            addBlockCnt++
        }

        debug( ` - added ${addBlockCnt} blocks, new re-tabulating ledger and going ONLINE.`)
        
        // now reprocess pending
        // BUGBUG remove, just shows balances for debugging purposes
        debug( `\n\n== LEDGER =========================================================`)
        this.ledger.walletBalances()

        return { error: false, blocks, hashes, newHashes, addBlockCnt, transactionCnt, adminCnt, miningFees, resetLedger }
    }
}