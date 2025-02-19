
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
import { urlCall, sha256Hash, fixRounding, time } from './helper.js'
import { createDecipheriv } from 'crypto'

// Blockchain Class ==============================================================
export default class Blockchain {
    constructor({ nodeName, version, ledger, dataPath }) {
        this.nodeName = nodeName
        this.ledger = ledger
        this.version = version          // network id + protocol version
        this.miningReward = 100         // adjusted each block addition
        this.difficulty = 1
        this.transactionFee = 0.01      // each transaction incurs a min fee to miner (higher fee can mean faster minting in life, we simplify to flat)
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
            const result = this.addBlock(blockData, { readOnly: true })
            block = result.block
            if( result.error && block.fileCache ) block.deleteFile() // invalid next block, erase it to re-sync proper one
            blockData.index++
        } while( block?.fileCache )

        if( blockData.index > 1 ){
            // now lets update ledger transactions for the chain
            this.syncBlockTransactions()

        } else {
            // no existing blocks, create genesis
            console.log( `~~ No existing blockchain, starting with genesis block that specifies the money supply available`)
            // for our tracking we create a mint supply, BTC doesn't do this housekeeping
            const genesisTransaction = this.transaction({ src: '_', dest: '_mint', amount: 1000000, type: 'mintIssue', timestamp: 0 })
            const result = this.addBlock({ index: 0, transactions: [ genesisTransaction ] })
            if( result.error ){
                console.log( `SERIOUS problem, unable to create genesis block. Check your filesystem.`)
                process.exit(-1)
            }
        }
    }

    height() {
        return this.chain.length-1
    }


    getBlock(index=-1) {
        if( index > this.height() ) return false
        return index === -1 ? this.chain.at(-1) : this.chain[index]
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
        const { prepareOnly = false, readOnly = false, compress = this.compress, 
                nodeName = this.nodeName, dataPath = this.dataPath } = options

        let index = this.height()+1
        if( blockData.index && blockData.index !== index ){
            // if adding it MUST be sequentially AFTER last block
            // console.log( `x [addBlock] New block must be index+1 on last block, or empty index for us to fill in; block: `, blockData )
            return { error: `Attempted [addBlock] failed: block must be index+1 height (or empty index). Rejecting.`, block: {} }
        }

        // build the block structure
        blockData.index = index
        blockData.prevHash = index>0 ? this.chain[index-1].hash : '0' // get the hash from last
        // if mining, we MUST be owner of block
        if( prepareOnly || !blockData.minerName ){
            blockData.minerName = this.nodeName
            blockData.version = this.version // version of block
        }

        const newBlock = new Block(blockData, { nodeName, compress, dataPath })

        // a block already existing will have a fileCache entry; if we readOnly, this MUST exist as don't want to create new
        if( readOnly && !newBlock.fileCache){
            // console.log( `x read-only mode but no pre-existing could be loaded for index(${index}), rejecting adding.` )
            return { error: `read-only mode but NO pre-existing could be loaded for index(${index}), rejecting adding.`, block: {} }
        }

        if( prepareOnly ){
            // prepareOnly means it wants the structure of the block, but will now pass off to mine.
            // this.generateProofOfWork(newBlock)
            // offload this work to the MinerWorker thread, so return with the block to mine
            return { error: false, block: newBlock }
        }
        
        // Audit created block to make sure it will pass (always should)
        const result = this.auditBlockValid( newBlock )
        if( result.error ){
            console.log( `[addBlock] auditBlockValid FAILED on #${result.index}: ${result.error}` )
            // reset offending things? transactions (transactionCnt.hash)? etc
            return { ...result, block: newBlock }
        } 

        if( !newBlock.fileCache ){
            // no cache file, so it's a new block, write it
            newBlock.writeFile()
            console.log(` + block #${newBlock.index}: imported (${result.transactionCnt} transactions) & wrote file`)
        } else {
            console.log(` + block #${newBlock.index}: imported (${result.transactionCnt} transactions)`)
        }
        // BUGBUG show all balances for testing purposes
        if( !readOnly ) this.ledger.walletBalances()

        // add to chain, exclude fileCache setting
        this.chain.push(newBlock)

        // update mining rewards info
        const calc = this.calcMiningReward(this.chain.length)
        this.miningReward = calc.miningReward
        this.difficulty = calc.difficulty

        return { error: false, block: newBlock }
    }

    auditBlockValid( currentBlock ){
        const index = currentBlock.index
        const fileCache = currentBlock.fileCache
        if (currentBlock.hash !== currentBlock.calcHash()) {
            console.log(`Current block #${index} hash(${currentBlock.hash}) is different from calcHash()(${currentBlock.calcHash()}), rejecting!`);
            console.log( currentBlock )
            return { error: `Current block hash is invalid, rejecting.`, index, fileCache }
        }

        // determine the reward, for place of current block
        const calc = this.calcMiningReward(index)

        // check timestamps are ok (should be within medium of last 12 blocks)

        // check PoW valid
        const hashPrefix = '0'.repeat(calc.difficulty)
        if( currentBlock.index > 0 && !currentBlock.hash.startsWith(hashPrefix) ){
            console.log(`Block#${currentBlock.index}: Invalid hash (${currentBlock.hash}), first ${calc.difficulty}-bytes must be 0, rejecting!`, currentBlock)
            return { error: `Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`, index, fileCache }
        }
        
        // check transactions are all signed
        let rewardCnt = 0, transactionError = false, transactionCnt = 0
        const blockMiner = currentBlock.minerName
        for( transactionCnt = 0; transactionCnt < currentBlock.transactions.length; transactionCnt++){
            const transaction = currentBlock.transactions[transactionCnt]
            let transactionValid = false
            const hash = this.ledger.calcHash(transaction)
            // console.log( `~ AUDIT transaction txSig(${transaction.txSig}) calcHash(${hash}) source(${transaction.source}) type(${transaction.type})`, transaction )
            if( transaction.hash !== hash ) {
                console.log( `  x hash(${transaction.hash} INVALID)`)
                transactionError = `Block audit failed: hash(${transaction.hash} not matching hash`
            }

            if( transaction.txSig && transaction.txSig.length>100 ){
                const publicKey = this.ledger.getPublicKey(transaction.src)

                // only allow certain transaction types for signed transactions
                if( !['minerDeposit','transfer','escrow',''].includes(transaction.type) )
                    transactionError = `Signed transaction but invalid type(${transaction.type}). Rejecting.`

                else if( this.ledger.walletVerify(publicKey, transaction.txSig, hash) ){
                    transactionValid = true
                    // console.log( `  VALID: wallet-signed transaction ${transaction.amount} [${transaction.type || ''}]` )
                } else {
                    transactionError = `Block audit failed: txSig(${transaction.txSig} signed (publicKey: ${publicKey}), but did not match hash.`
                }

            } else {
                // its admin-level signed, device if its likely real
                if( transaction.type === 'miningReward' ){
                    if( transaction.dest.startsWith(blockMiner+':') && transaction.amount == calc.miningReward ){
                        rewardCnt++
                        transactionValid = true
                    } else {
                        transactionError = `Block miningReward illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}). Rejecting.`
                    }

                } else if( transaction.type === 'mintAirDrop' ){
                    // should probe back to core system if sanctioned
                    // console.log( `  VALID: admin-level transaction ${transaction.amount} [${transaction.type}]` )
                    transactionValid = true

                } else if( transaction.dest.startsWith(blockMiner+':') && transaction.type === 'miningFees' && transaction.source ){
                    // check this is validly paired to a valid transaction
                    // TODO check they match up with signed transactions that triggered them

                    // it's an alleged admin transaction should be a fee payment
                    // const matchTransaction = unresolvedTransactions.filter( item => item.txSig === transaction.source )
                    // if( matchTransaction[0].fee == transaction.amount)
                    // console.log( `  - transaction _hash valid; found a 'source' entry : `, matchTransaction)

                    transactionValid = true

                } else if( transaction.type === 'mintIssue' ){
                    // mint issue normally only genesis block; unless increasing supply
                    // TODO do we allow outside genesis? && index === 0 ?
                    transactionValid = true

                } else {
                    console.log( `  - transaction #${transaction.hash} txSig(${transaction.txSig}) type(${transaction.type}) INVALID.` )
                    transactionError = `Block audit failed: hash(${transaction.hash} txSig(${transaction.txSig}) type(${transaction.type}) INVALID`
                }

            }

            if( !transactionValid ){
                transactionError = { error: transactionError, transaction }
                break
            }
        }

        // an object with transaction error will be returned, else simply false
        if( transactionError ) return transactionError
        
        if( currentBlock.index > 0 && rewardCnt !== 1 ){
            console.log( `Failed transaction, should have only ONE miningReward, found ${rewardCnt}` )
            return { error: `Failed transaction, should have only ONE miningReward, found ${rewardCnt}` }
        }
        // NOTE: actual transaction validity is checked at the miner level, the block checks out otherwise
        return { error: false, transactionCnt }
    }

    auditChainValid( chain = this.chain ) {
        // scan chain from index=0 onward checking chained hashes
        for (let i = 0; i < chain.length; i++) {
            const currentBlock = chain[i];
            if( currentBlock.index != i ) {
                console.log(`Current block index(${currentBlock.index}) wrong for position(${i}), rejecting!`);
                return { error: `Current block index(${currentBlock.index}) wrong for position(${i}), rejecting.` }
            }

            if( i > 0 ){
                const prevHash = chain[i - 1].hash;
                if (currentBlock.prevHash !== prevHash) {
                    console.log(`Block#${currentBlock.index} currentBlock.prevHash(${currentBlock.prevHash}) doesn't match passed-in prevHash(${prevHash}), rejecting!`)
                    return { error: `Previous block hash does not match, so it's not next in chain, rejecting.` }
                }
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
                console.log( `**STRANGE** Two transactions with same hashes: #${trans.index} `)
                trans.index += ',' + blockIdx
            }
        }
        return { isNew, index: trans.index }
    }

    // add the layer of tracking blockchain transactions
    transaction(data, blockIndex) {
        const { isNew, index }= this.findOrCreateHash( data.hash, blockIndex )
        
        let transaction
        if( isNew ){
            transaction = this.ledger.transaction(data)
            if( transaction.error ){
                transaction = { error: transaction.error, index }
            } else {
                // create an entry for this with the actual hash
                if( !data.hash ) this.findOrCreateHash( transaction.hash, blockIndex )
                if( data.hash === transaction.hash )
                    console.log( `     \\ new, with hash, processed ledger transaction; hash=${transaction.hash}`)
                else
                    console.log( `     \\ new, without hash, processed ledger transaction; created hash=${transaction.hash}`)
            }
        } else {
            transaction = { error: `Already exists in block #${index}`, index }
            // console.log( `     . not new; ledger already reflects transaction, updated block#(${index}) in transactionHash `)
        }
        return transaction
    }

    transactionReverse(data) {
        const reverseTransaction = this.ledger.transactionReverse(data)
        // no error in reversal, remove the transaction hash
        if( !reverseTransaction.error )
            delete this.transactionHashes[data.hash]

        return reverseTransaction
    }

    syncBlockTransactions( fromIndex=0,size=0 ){
        // run ledger transaction & add to hash list
        let newHashes = [], hashes = [], error = '', transactionCnt = 0
        const addTransaction = ( t, blockIdx ) => {
            const transaction = this.transaction(t, blockIdx)
            hashes.push( t.hash )
            transactionCnt++
            if( transaction.error ){
                if( !transaction.index || transaction.index<0 ){
                    // failed so delete reference to this transaction hash
                    console.log( ` .. transaction REAL error (${transaction.error}), deleting from transactionHashes[]`)
                    delete this.transactionHashes[t.hash]
                    hashes.slice(0,-1)
                    transactionCnt--
                    error += transaction.error + ','
                } else {
                    console.log( `  .. transaction failed, but OK: in #${transaction.index}`)
                }
            } else {
                // console.log( ` .. [syncBlockTransactions] (${t.hash}, ${blockIdx}) -> #${transaction?.index||'NEW'}`)
                // console.log( ` added new transaction (${transactionCnt})`)
                newHashes.push( transaction.hash )
            }
            return { error, transactionCnt, hashes, newHashes }
        }
        // scan each block, then generate transactions for each entry
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        console.log( `[syncBlockTransactions] Scanning from #${fromIndex} for ${size>0 ? size : 'all'} blocks & building...` )
        chain.forEach( block => {
            console.log( `\n- [block#${block.index}]: (transactions: ${block.transactions.length}) ------------------------------------------------------------------------` )
            block.transactions.forEach( t => addTransaction(t,block.index) )
        })
        return { error: false, transactionCnt, hashes, newHashes }
    }
    
    getBlockchainHashes(fromIndex=0,size=0) {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let hashes = []
        for( const block of chain )
            hashes.push( block.hash )
        return hashes
    }
    
    getBlockchain(fromIndex=0,size=0) {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let blocks = []
        for( const block of chain ){
            // delete meta-data in block before passing on
            const { fileCache, nodeName, compress, dataPath, ...pureBlock }= block
            blocks.push( pureBlock )
        }
        // // delete on-server attributes, not relevant for others (and doesn't affect hash)
        // chain.forEach( block =>{ delete block.fileCache; delete block.nodeName; delete block.compress; delete block.dataPath; })
        // return chain
        return blocks
    }

    addBlockchain(chain) {
        let addBlockCnt = 0;
        const fromIndex = chain[0].index
        for( const blockData of chain ){
            const result = this.addBlock(blockData)
            if( result.error ) return result
            addBlockCnt++
        }

        console.log( ` - added ${addBlockCnt} blocks, new re-tabulating ledger and going ONLINE.`)
        // now load transactions from all those saved blocks into our ledger ...
        const syncResult = this.syncBlockTransactions(fromIndex,addBlockCnt) 
        if( syncResult.error ) return syncResult

        // BUGBUG remove, just shows balances for debugging purposes
        console.log( `\n\n== LEDGER ========================================`)
        this.ledger.walletBalances()

        return { error: false, addBlockCnt, transactionCnt: syncResult.transactionCnt }
    }
}