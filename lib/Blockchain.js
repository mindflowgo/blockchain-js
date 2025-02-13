
import bs from 'bs58'
import Block from './Block.js'
import { urlCall, sha256Hash, fixRounding, time } from './helper.js'

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

        // load only EXISTING blocks, and add to chain
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
            this.updateTransactionsFromBlock()

        } else {
            // no existing blocks, create genesis
            console.log( `~~ No existing blockchain, starting with genesis block that specifies the money supply available`)
            // for our tracking we create a mint supply, BTC doesn't do this housekeeping
            const genesisTransaction = this.ledger.transaction({ src: '_', dest: '_mint', amount: 1000000, type: 'mintIssue', timestamp: 0 })
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
        const difficulty = fixRounding( 2 + Math.floor(index/10) )

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
        const { prepareOnly = false, readOnly = false, compress = this.compress, nodeName = this.nodeName, 
                dataPath = this.dataPath } = options
        
        // if adding it MUST be sequential after last block
        const index = this.height()+1
        if( blockData.index && blockData.index !== index ){
            console.log( `x New block must be index+1 on last block, or empty index for us to fill in`)
            return { error: `New block must be index+1 on last block, or empty index for us to fill in`, block: {} }
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

        // mine for it, so return structure to PoW it!
        if( prepareOnly ){
            // this.generateProofOfWork(newBlock)
            // offload this work to the MinerWorker thread, so return with the block to mine
            return { error: false, block: newBlock }
        }
        
        // Audit created block to make sure it will pass (always should)
        const result = this.auditBlockValid( newBlock )
        if( result.error ){
            console.log( `[addBlock] auditBlockValid FAILED: ` )
            // reset offending things? transactions (transactionCnt.hash)? etc
            return { ...result, block: newBlock }
        } 

        if( !newBlock.fileCache ){
            // no cache file, so it's a new block, write it!
            newBlock.writeFile()
            console.log(` + imported (${result.transactionCnt} transactions) & wrote new block #${newBlock.index}`)
        } else {
            console.log(` + imported (${result.transactionCnt} transactions) existing block #${newBlock.index}`)
        }
        // BUGBUG show all balances for now
        this.ledger.walletBalances()

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
            console.log(`Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`)
            return { error: `Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`, index, fileCache }
        }
        
        // check transactions are all signed
        let rewardCnt = 0, transactionError = false, transactionCnt = 0
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
                    if( transaction.dest.startsWith(currentBlock.minerName+':') && transaction.amount == calc.miningReward ){
                        rewardCnt++
                        transactionValid = true
                    }

                } else if( transaction.type === 'mintAirDrop' ){
                    // should probe back to core system if sanctioned
                    // console.log( `  VALID: admin-level transaction ${transaction.amount} [${transaction.type}]` )
                    transactionValid = true

                } else if( transaction.type === 'miningFees' && transaction.source ){
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
                // console.log( `[auditBlock] FAILED: ${transactionError}, rejecting block.`)
                transactionError = { error: transactionError, transaction }
                break;
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

    updateTransactionsFromBlock( blockIdx=0 ) {
        // scan each block, then generate transactions for each entry
        let transactionResult = []
        if( blockIdx>0 ){
            this.getBlock(blockIdx).transactions.forEach( t => transactionResult.push(this.ledger.transaction(t)) )
        } else {
            console.log( `\n[updateTransactionsFromBlock] Scanning all blocks & building...` )
            this.chain.forEach( block => {
                console.log( `- [block#${block.index}]: -----------------------------------` )
                block.transactions.forEach( t => transactionResult.push(this.ledger.transaction(t)) )
            })
        }

        const transactionErrors = transactionResult.map( t => t.error || '')
        const transactionCnt = transactionResult.length - transactionErrors.length
        return { error: transactionErrors.join(',') || false, transactionCnt }
    }
    
    getBlockchain(fromIndex=0,size=0) {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        // delete on-server attributes, not relevant for others (and doesn't affect hash)
        chain.forEach( block =>{ delete block.fileCache; delete block.nodeName; delete block.compress; delete block.dataPath; })
        return chain
    }

    addBlockchain(chain) {
        let addBlockCnt = 0;
        for( const blockData of chain ){
            const result = this.addBlock(blockData)
            if( result.error ) return result
            addBlockCnt++
        }
        return addBlockCnt
    }
}