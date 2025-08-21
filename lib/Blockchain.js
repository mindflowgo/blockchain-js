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

import { fixRounding, time, debug } from './helper.js'

import Block from './Block.js'
import Crypto from './Crypto.js'

// preset characteristics of this blockchain
const GENESIS_ISSUE = 1000000000        // coin-pool size established at genesis
const MINING_REWARD = 100               // initial mining reward
const BLOCK_TIMESTAMP_TOLERANCE = 7200  // 30 mins, allow blocks to be off by up 2 hours
const DEBUG_MODE = 1 // when on: limits block difficulty, outputs ledger after each addBlock
// admin types not adjustable: tokenCreate, tokenAdjust, tokenAirdrop, miningReward, miningFees

// Blockchain Class ==============================================================
export default class Blockchain {
    // updated passed in variables, and load blockchain from data source
    constructor( version, nodeName, TransactionHandler, Mempool, Wallet) {
        // variables used
        this.version = version
        this.nodeName = nodeName
        this.miningReward = MINING_REWARD // adjusted each block addition
        this.difficulty = 1

        // our actual chain
        this.chain = [] 

        // remember the classes
        this.TransactionHandler = TransactionHandler
        this.Mempool = Mempool
        this.Wallet = Wallet

        // lets load the chain
        let loadBlockIndex = 0
        // let block
        while( 1 ){
            // pre-load only EXISTING blocks (uses the 'index' value to trigger loading), and add to chain
            const result = this.addBlock({ index: loadBlockIndex }, { readOnly: true, txUpdate: true })
            if( result.error ){
                // problem adding this block, stop adding the chain, and print message (it will reload chain from another system)
                if( result.block ) debug('red', `\n` + result.error)
                break
            }
            // block = result.block
            loadBlockIndex++
        }

        // no existing blocks (errors at 0-aka-genesis block load), create genesis
        if( loadBlockIndex < 1 ){
            debug( `~~ No existing blockchain, creating genesis block that specifies the money supply available`)
            // for our tracking our genesis defines our mint supply (BTC doesn't do this, they simply "mint" with block creation)
            const genesisData = Block.buildGenesis(GENESIS_ISSUE,this.TransactionHandler) // static call (as instance of block not yet created)
            const genesisBlock = new Block(genesisData,{forceOverwrite: true})
            const { error, hashes, transactionCnt } = this.addBlock(genesisBlock, {foreOverwrite: true, txUpdate: true})
                        
            if( error ){
                // deleting it so next run re-creates it.
                genesisBlock.deleteData()
                debug( 'red', `SERIOUS problem, unable to create genesis block. Check your filesystem and run again`)
                process.exit(-1)
            }
            // // now remove that transaction from mempool as issued
            // this.Mempool.delete( hashes )
            debug( `~~ Genesis created with ${transactionCnt} transactions;`)
        }
    }

    height() {
        return this.chain.length
    }

    calcMiningReward({ index, update = true }){
        // Reward for mining a block, decreases with every 10 blocks minted (ex. for real BTC: 50 / 2**Math.floor(index/210000); reward halves every 210,000 blocks)
        // Freshly-mined coins cannot be spent until 100 blocks deep; this is HOW BTC is issued!
        const miningReward = fixRounding( 100 / 2**Math.floor(index/10) )

        // mining nonce difficulty increase every 10 blocks (real BTC: every 2016 blocks to maintain block time of 10 minutes)
        let difficulty = 2 + Math.floor(index/10)
        // for debug limit how hard else it can get really slow
        if( DEBUG_MODE && difficulty > 5) difficulty = 5

        if( update ){
            this.miningReward = miningReward
            this.difficulty = difficulty
        }
        return { miningReward, difficulty }
    }

    getBlock(index=-1) {
        if( index < -1 || index >= this.height() ) return false
        return this.chain.at(index)
    }
    
    addBlock(blockData, options = {}){ 
        const { prepareOnly = false, readOnly = false, forceOverwrite = false, 
                txUpdate = false } = options

        if( readOnly && (prepareOnly || forceOverwrite) )
            return { error: `Cannot add a block with readOnly withprepareOnly or forceOverwrite. Rejecting.`}
        
        const index = this.height()
        if( blockData?.minerName !== 'genesis' && (blockData?.index && blockData.index !== index) ){
            // if adding it MUST be sequentially AFTER last block
            // debug( `x [addBlock] New block must be index+1 on last block, or empty index for us to fill in; block: `, blockData )
            return { error: `Attempted adding new block (addBlock) but new block index=${blockData.index}), accepting index=${index} now (or empty index). Rejecting.` }
        } else {
            // possibly no index set, so let's just re-affirm it
            blockData.index = index
        }

        // if mining (prepareOnly), we MUST be owner of block
        if( prepareOnly ){
            // overwrite some fields for prepare only
            blockData = {
                ...blockData,
                prevHash: this.getBlock(index-1).hash, // get the hash from previous block
                minerName: this.nodeName,
                version: this.version, // version of block
            }
        }

        // assemble block object
        const newBlock = new Block(blockData, options)
        if( newBlock.error ) return newBlock

        if( readOnly && !newBlock.fileCache)
            // debug( `x read-only mode but no pre-existing could be loaded for index(${index}), rejecting adding.` )
            return { error: `Read-Only mode BUT *NO* pre-existing could be loaded for index(${index}), aborting.` }

        // set the cleaned up transactions (removing meta); calc merkleroot; update block hash
        if( !readOnly && (newBlock.minerName === this.nodeName || newBlock.minerName === 'genesis' ) ){
            newBlock.transactions = this.TransactionHandler.removeMeta(newBlock.transactions)
console.log( `[addBlock] writing transactions without meta data: `, newBlock.transactions)
            // build merkle tree, grab the root value
            const merkleTree = Crypto.merkleBuild( newBlock.transactions )
            newBlock.merkleRoot = merkleTree.pop()[0]
            // recalc hash using merkleRoot change
            newBlock.hash = newBlock.calcHash()
        }
        
        const { error, transactionCnt, adminCnt, miningFees }= 
            this.TransactionHandler.auditTransactions(newBlock.minerName, newBlock.index, newBlock.transactions, this.miningReward)
        if( error ) return error
        // a block already existing will have a fileCache entry; if we readOnly, this MUST exist as don't want to create new

        if( prepareOnly ){
            // prepareOnly means it wants the structure of the block -> gives to MinerWorker
            return { error: false, block: newBlock }
        }

        // INSERTING BLOCK INTO CHAIN ...
        // First: make sure this block fits onto the existing chain ok
        const auditLink = this.addValidate( newBlock )
        if( auditLink.error ){
            debug('red',`[addBlock] auditBlockValid FAILED on #${index}: ${auditLink.error}`)
            return { ...auditLink, block: newBlock }
        } 

        // It's good - write the file (if didn't exist and load from cache)
        if( !newBlock.fileCache || forceOverwrite ) // no cache file, so it's a new block, write it
            newBlock.writeData(forceOverwrite)
        
        // now sync up the transactions in this block to this.Mempool, and the this.Wallet
        const syncResult = this.TransactionHandler.processTransactions( newBlock.transactions, { blockIdx: newBlock.index, txUpdate: true })
        if( syncResult.error ) return syncResult

        const { hashes, newHashes }= syncResult
        debug('cyan', `  > block #${newBlock.index} ready: imported${transactionCnt>0 ? ` +${transactionCnt} user-transactions` : '' } ${adminCnt>0 ? ` +${adminCnt} admin-transactions` : '' }${miningFees>0 ? `; $${miningFees} mining fees` : ''} ${ forceOverwrite || !newBlock.fileCache ? ` [wrote file]` : ''} `)

        // finally, add it to the blockchain! (remove fileCache guidance)
        delete newBlock.fileCache
        this.chain.push(newBlock)

        // successful published to chain: now for any token issue transactions, update this.Wallet
        if( adminCnt>0 ){
            const issueTransactions = this.TransactionHandler.filter({ transactions: newBlock.transactions, types: 'tokenCreate' })
            for( const transaction of issueTransactions ){
                const destWallet = this.Wallet.getUser(transaction.dest, false)
                if( destWallet.error && transaction.type === 'tokenCreate' ){
                    debug('red',`Some REALLY wrong happened. Token issue transaction exists without a matching WALLET for the token (${transaction.dest}), type(${transaction.type})`)
                    continue
                }
                debug('cyan',`  > ~ [admin-transaction] found token issue (${transaction.dest}) for ${transaction.amount} tokens. tokenAdmin: ${transaction.tokenAdmin}`)
                if( !transaction.tokenAdmin ) continue
                this.Wallet.update(transaction.dest, { tokenAdmin: transaction.tokenAdmin })
            }
        }

        // update height for ledger to know
        this.Wallet.setMaxBlock( newBlock.index )

        // update mining rewards info
        this.calcMiningReward({ index: this.chain.length })

        return { error: false, block: newBlock, hashes, newHashes, transactionCnt, adminCnt, miningFees }
    }

    

    addValidate( block ){
        const index = block.index

        // check prevHash + timestamp
        if (index > 0) {
            const prevHash = this.getBlock(index - 1).hash
            if (block.prevHash !== prevHash) {
                debug('red',`Block#${index} block.prevHash(${block.prevHash}) doesn't match passed-in prevHash(${prevHash}), rejecting!`)
                return { error: `Previous block hash does not match, so it's not next in chain, rejecting.`, index }
            }

            // Check block timestamp is basically valid (within a window, ex 2 hours ) 
            // average last 3 blocks for the timestamp
            const prevTimestamp = this.height()<10 ? this.getBlock(index - 1).timestamp 
                : Math.floor((this.getBlock(index - 1).timestamp + 
                              this.getBlock(index - 2).timestamp + 
                              this.getBlock(index - 3).timestamp)/3)
            if (block.timestamp <= (prevTimestamp - BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${index} timestamp (${block.timestamp}) is before or equal to previous 3-block average (${prevTimestamp} + ${BLOCK_TIMESTAMP_TOLERANCE})` )
                return { error: 'Invalid block timestamp: Must be after previous block' }
            }
            if (block.timestamp > (time() + BLOCK_TIMESTAMP_TOLERANCE)) {
                debug('red',`Block #${index} timestamp (${block.timestamp}) is too far in the future`)
                return { error: 'Invalid block timestamp: Too far in the future' }
            }
        }
        return true
    }

    auditFullChainValid( chain = this.chain ) {
        // scan chain from index=0 onward checking chained hashes
        for (let i = 0; i < chain.length; i++) {
            const block = chain[i]
            if( block.index != i ) {
                debug('red', `Current block index(${block.index}) wrong for position(${i}), rejecting!`)
                return { error: `Current block index(${block.index}) wrong for position(${i}), rejecting.` }
            }

            // LINK: check it's timestamp/hash links are correct, so that adding it won't break the chain
            const result = this.addValidate( block )
            if( result.error ) return result
            
            // BLOCK: quickly check the block itself is ok!
            // determine the reward, for place of current block (don't update block settings though)
            const calc = this.calcMiningReward({ index: block.index, update: false })

            // check block hash + PoW valid
            if( !block.isHashValid( calc.difficulty,block.calcHash() ) ){
                debug('red',`Block#${block.index}: Invalid hash (${block.hash}), first ${calc.difficulty}-bytes must be 0 - hash (${block.hash}), rejecting!`)
                return { error: `Invalid hash, first ${calc.difficulty}-bytes must be 0, rejecting!`, index }
            }        

            // BLOCK TRANSACTIONS: check actual transactions are vali
            const auditTransactions = this.TransactionHandler.auditTransactions(block.transactions,calc.miningReward)
            if( auditTransactions.error ) return error
            const { transactionCnt, adminCnt, miningFees } = auditTransactions

            debug('', ` - block #${block.index} ${transactionCnt} transactions; miningFees: ${fixRounding(miningFees)}`)
            //return { error: false, transactionCnt, adminCnt, miningFees:  }
        }
        return true;
    }
       
    getChain(fromIndex=0,size=0,fields='') {
        const chain = this.chain.slice(fromIndex, size>0 ? fromIndex+size : this.chain.length )
        let result = []
        if( fields === 'hashes')
            result = [ ...chain.map( ({index, hash}) =>{ return {index, hash} })]
        else if( fields === 'meta')
            result = [ ...chain.map( ({index, minerName, timestamp, powTime}) =>
                        { return {index, minerName, timestamp, powTime}} )]
        else
            // peel off meta-data in block before passing on all block-only data
            result = [ ...chain.map( ({powTime, ...data}) => data )]
        return result
    }

    addChain(chain, blockOptions = {}){
        const { readOnly = false, forceOverwrite = false } = blockOptions
 
        let addBlockCnt = 0, blockHashes = [], newHashes = [], transactionCnt = 0, adminCnt = 0, miningFees = 0
        const fromIndex = chain[0].index

        // if OTHER chain is longer, we extract our minted transactions > pending; then CUT CHAIN SHORT + add external blocks
        let resetWallet = false
        if( forceOverwrite && this.height() > fromIndex ){
            const chainExcessBlocks = this.height() - fromIndex

            // go through rebuilding the transactions to that point
            debug( `    ~ clearing and re-calcing wallet balances (optimize?)`)
            this.Wallet.resetAllTokens()
            resetWallet = true
            this.Mempool.reset()
                        
            // quickly EXTRACT transactions this miner was attempting to push to blockchain
            const dropChain = this.chain.slice(fromIndex, this.height())
            let blockIdx = fromIndex
            for( const block of dropChain ){
                // allow dropping sliced blocks from other miners (they'll deal with it themselves, we only care about our miner blocks)
                if( block.minerName !== this.nodeName ) continue

                // extracts this miner's mined user/admin transactions back to mempool
                const transactions = this.TransactionHandler.filter({ transactions: block.transactions, type: 'user,admin' })
                this.Mempool.addQueue( transactions )
                // indicate queue time
                this.TransactionHandler.updateMeta( transactions,'queueTime',time() )

            }

            debug( `    ~ re-added dropped-chain transactions from this server to pending; shortening blockchain by ${chainExcessBlocks}`)
            this.chain = this.chain.slice(0, -chainExcessBlocks)

            debug( 'dim' )
            for( const block of this.chain ){
                let syncResult = this.TransactionHandler.processTransactions( block.transactions, { blockIdx: block.index, txUpdate: true })
                if( syncResult.error ) return syncResult
            }
            debug( 'reset' )
        }

        let blocks = []
        for( const blockData of chain ){
            const addResult = this.addBlock(blockData, { ...blockOptions, txUpdate: true })
            if( addResult.error ) return addResult

            blockHashes = blockHashes.concat(addResult.hashes)
            newHashes = newHashes.concat(addResult.newHashes)
            transactionCnt += addResult.transactionCnt
            adminCnt += addResult.adminCnt
            miningFees += addResult.miningFees
            blocks.push(addResult.block)
            addBlockCnt++
        }

        debug( ` - added ${addBlockCnt} blocks, new re-tabulating ledger.`)
        // remove any ququed in our memory that were found in processed blocks, and hence don't need to be processed...
        this.Mempool.deleteQueue( blockHashes )
        
        if( DEBUG_MODE ){
            debug( `\n\n== LEDGER =========================================================`)
            this.Wallet.balances()
        }

        return { error: false, hashes: blockHashes, newHashes, addBlockCnt, transactionCnt, adminCnt, miningFees, resetWallet, blocks }
    }
}