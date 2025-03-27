/******************************************
 * Mining Transaction Class
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * 
 * MIT License
 * 
 * This class provides transaction management within the miner
 * 
 * Unconfirmed/pending transactions are dealt with in the node as they are relevant to it's
 * operations in deciding blocks to mine, and what info to communicate to other nodes.
 */

import { urlCall, sha256Hash, fixRounding, time, waitReady, debug } from './helper.js'

const MAX_PENDING_PER_USER = 16             // prevent user-spamming transactions, limit how many we accept in our pending list
const PENDING_TRANSACTION_STALE = 300       // time after which we flush pending as stale
const TRANSACTION_FEE = 0.01            // 1%
const TRANSACTION_FEE_MAX = 0           // most to charge

// Miner Class =================================================================================
export default class TransactionManager {
    constructor({ nodeName, ledger }) {
        this.nodeName = nodeName
        this.ledger = ledger
        this.blockchain = null
        this.transactionFee = TRANSACTION_FEE
        this.transactionFeeMax = TRANSACTION_FEE_MAX

        this.pending = []       // mempool transactions want to put into an upcoming block
        this.hashes = {}        // transaction hashes over whole chain (using object not array)
    }

    findOrCreateHash( hash, blockIdx=-1 ){
        // no hash passed-in -> means it MUST be new
        if( !hash || hash.length<43 ) return { error: false, isNew: true, index: -1 }

        // hash passed in, but not present in lookup table, so it's new
        const isNew = this.hashes[hash] === undefined
        
        if( isNew ){
            // create entry (-1 = pending, no assigned block)
            this.hashes[hash] = { index: blockIdx, created: time() }
        } else if(  blockIdx > -1 ){
            const foundData = this.hashes[hash]

            if( foundData.index === -1 ){
                // converting from pending (-1) to block #
                foundData.index = blockIdx
            } else if( foundData.index !== blockIdx ){
                debug( 'red', `**STRANGE** Two transactions with same hashes: blockIdx(${blockIdx}) but hash has: #${foundData.index} `)
                return { error: `Attempting to create same hash with different block, not allowed`, index: foundData.index }
            }
        } else {
            // hash already exists in mempool, so nothing to needed to do (duplicate request)
            return { error: `Hash already exists, disallowing another pending with same hash.`, index: -1 }
        }
        return { error: false, isNew, index: this.hashes[hash].index }
    }

    getFee({ amount, fee=0 }){
        // transaction occurs in Ledger, but we contribute the fee our miner charges here
        // users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        //  miner can override upward the fee        
        if( fee<0 ) fee = 0
        fee = fixRounding( Math.max(fee, Number(amount || 0) * this.transactionFee) )
        if( this.transactionFeeMax > 0 )
            fee = Math.min(this.transactionFeeMax, fee)
        return fee
    }
    
    syncToChain(){
        if( this.ledger.wallets.length<1 ) return
        // if there are no pending for a tx, it MUST be same as onChain, else we sync
        // this may be due to BUGBUG bugs in the system, as this shouldn't happen but it does
        // with complex intermeshed queries
        for( const publicKey of Object.keys(this.ledger.wallets) ){
            const wallet = this.ledger.wallets[publicKey]
            const transName = this.pending.length === 0 ? '' : this.ledger.buildTransactionName(wallet.name,wallet.publicKey)
            const matchTransactions = this.pending.length === 0 ? [] : this.pending.filter(t => (t.src === transName || t.dest === transName) )
            // we only try to balance _mint when there are no pending, otherwise it could be a mined block in progress...
            if( this.pending.length === 0 || (transName !== '_mint' && matchTransactions.length === 0) ){
                if( wallet.tx.balance !== wallet.onChain.balance ){
                    debug( 'cyan', `   ~ [syncToChain] ${wallet.name} no pending but chain diff: tx.balance(${wallet.tx.balance}) onChain.balance(${wallet.onChain.balance}), sync to onChain value.`)
                    wallet.tx.amount = wallet.onChain.amount
                    wallet.tx.balance = wallet.onChain.balance
                    wallet.tx.seq = wallet.onChain.seq
                }
            }
        }
    }

    reloadPending(){
        return this.newBatch( this.pending )
    }

    newBatch( _transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false }= options

        // run ledger transaction & add to hash list
        let newHashes = [], hashes = [], result = [], error = '', transactionCnt = 0

        if( blockIdx>-1 ) debug('cyan',`\n- [block#${blockIdx}]: (transactions: ${_transactions.length}) ------------------------------------------------------------------------` )
        for( const _transaction of _transactions ){
            const transaction = this.new(_transaction, { blockIdx, txUpdate })
            hashes.push( _transaction.hash || transaction.hash )
            result.push( transaction ) // includ transaction.error results
            if( transaction.error ){
                if( transaction?.index<0 ){
                    // failed so delete hash-look-up reference to this transaction hash
                    debug( 'dim', `   .. ${transaction.error} (Failed transaction; deleting hash)`)
                    delete this.hashes[_transaction.hash]
                    hashes.pop()
                    error += transaction.error + ','
                } else {
                    // failed, but likely innocuous: already exists, so continuing
                    debug('dim',`  ..${transaction.error}`)
                }
            } else {
                transactionCnt++
                newHashes.push( transaction.hash )
            }
        }
        
        return { error: error || false, result, transactionCnt, hashes, newHashes }
    }

    // prepare a transaction for miner (so adjust pending layer too)
    new({src, dest, amount, fee = 0, seq = 0, txSig = '', hash = '', ...data}, options = {} ) {
        const { blockIdx = -1, txUpdate = false, testOnly = false }= options
        // Validate transaction
        if (!src || !dest || !amount) {
            debug('red',`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            return { error: `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` }
        }

        // is it already in hash tracker?
        const { error, isNew, index }= this.findOrCreateHash( hash, blockIdx )
        if( error ) return error

        // managing stats in the src wallet
        const srcWallet =  this.ledger.getWallet(src)
        if( srcWallet.error ) return srcWallet // error return it

        let transaction
        if( isNew ){
            // fee
            if( src.startsWith('_') ){
                // _admins don't pay fees in our blockchain (& no sequential tracking)
                fee = 0
                
            } else {
                // reject new mempool entries if excess pending from this src (ie mempool flood)
                if( blockIdx === -1 ){
                    const transSrc = this.ledger.buildTransactionName(src, srcWallet.publicKey)
                    const pendingSrcCnt = this.pending.filter( t => t.src === transSrc ).length
                    if( pendingSrcCnt >= MAX_PENDING_PER_USER ) { 
                        return { error: `Sorry too many transactions (${pendingSrcCnt}) by user (${src}). Please resubmit later once blocks mined.` }
                    }
                }
                fee = this.getFee({ amount, fee })
            }

            transaction = this.ledger.transaction({src, dest, amount, fee, seq, txSig, hash, ...data}, { blockIdx, txUpdate, testOnly})
            if( transaction.error ){
                transaction = { error: transaction.error, index }

            } else if( !testOnly ){
                // create an entry for this with the actual hash
                if( !hash ){
                    const { error } = this.findOrCreateHash( transaction.hash, blockIdx )
                    if( error ){
                        // reverse the transaction
                        debug('cyan', `  ! duplicate transaction hash -> reversing`)
                        this.ledger.transaction({src, dest, amount, fee, seq, txSig, hash, ...data}, { blockIdx, txUpdate, reverse: true })
                        return error
                    }
                }

                if( !data.meta ) data.meta = { balance: 0 }
                data.meta.balance = blockIdx === -1 ? srcWallet.tx.balance : srcWallet.onChain.balance

                // queue in pending ONLY if not already in a block
                if( blockIdx === -1 )
                    this.addPending( transaction )
                
                debug('dim',`     \\ new, processed ledger transaction` 
                            + (hash !== transaction.hash ? '; created hash!' : '')
                            + (blockIdx === -1 ? '; added pending' : '')
                            + (data.note ? `; note: "${data.note}"` : '') )
            } else {
                debug('dim',`     \\ test/automated-only transaction` )
            }

        } else if( index > -1 ){
            // not new, so likely was a mempool, now converted to a block entry
            transaction = { error: `Not created, but updated wallet.onChain & transactionHash: block = #${index}${data.seq > 0 ? `; onChain(${data.seq})` : '' }`, updateSeq: true, index }
            
            // update ledger to reflect it's onChain (add value + update seq)
            // ***************** TODO re-think
            // transaction hash already exists, so mempool tx updated; we just want to update the onChain values...
            if( !testOnly ){ 
                const result = this.ledger.transactionWalletUpdate({ src, dest, amount, fee, seq, blockIdx })
                if( result.error ) return result
            }
        } else {
            debug( 'red', `[blockchain::transaction] Should NOT come here: hash(${data.hash} blockIdx(${blockIdx}))`)
            transaction = { error: `Should NOT come here: hash(${data.hash} blockIdx(${blockIdx})`, index }
        }

        return transaction
    }

    // when we fail to mine a block, since we'll be retrying, don't reverse any ledger balances (yet)
    reverseMineAborted( transactions ){
        let pending = 0, undo = 0
        for( const transaction of transactions ){
            if( transaction.hash && this.hashes[transaction.hash] ){
                // user transactions we'll retry - so don't reverse ledger
                debug('dim',`    ~ ${transaction.src.split(':')[0]}/${transaction.seq} >> ${transaction.dest.split(':')[0]} $${transaction.amount} [${transaction.type}] -> reverted to mempool.`)
                this.hashes[transaction.hash].index = -1
                pending++
            }
        }
        return { error: false, pending }
    }

    reverse({src, dest, amount, fee, seq, hash, ...data}){
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}
        // is it already in hash tracker?
        const hashData = this.hashes[hash]

        if( !hashData?.index ){
            debug('dim',`    ~ ${src.split(':')[0]}/${seq} >> ${dest.split(':')[0]} $${amount} -> no ${hash} entry, attempting pending clear`)
            this.pending = this.pending.filter( t => t.hash !== hash )
            return { error: false, index: '' }
        }

        if( hashData.index === -1 ){
            this.pending = this.pending.filter( t => t.hash !== hash )
            delete this.hashes[hash]
            debug('dim', `    ~ ${src.split(':')[0]}/${seq} >> ${dest.split(':')[0]} $${amount} -> removed pending entry + removed hash. Now reversing ledger values.`)
        }

        return this.ledger.transaction({src, dest, amount, fee, seq, hash, ...data}, { blockIdx: hashData.index, txUpdate: true, reverse: true })
    }

    reverseBatch( transactions ){
        let deleted = 0

        transactions.forEach( t => {
            // we do blockchain.transactionReverse as we do not want to remove from pending, will try again, new block#!
            const result = this.reverse(t)
            if( result.error ){
                debug('red', result.error )
                return result
            } else {
                deleted++
            }
        })
        return { error: false, deleted }
    }

    pendingCnt(txStakeLabel){
        if( txStakeLabel )
            return this.pending.length && ( this.pending.filter( t => t.meta.txStake.startsWith(txStakeLabel+':')) ).length
        else
            return this.pending.length
    }

    addPending( transaction ){
        this.pending.push( transaction )
    }

    getPending({ txStakeLabel, maxTransactions, metaInclude=true }){
        // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
        // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
        //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)

        // issue..airdrop..deposit FIRST (as affect src liquidity), then other movements, and LAST miningFees and finally miningReward
        // technically miningFees/miningReward should NEVER be in transactions, as they are added at the time blocks are minted
              
        const typeOrder = { mintIssue: 0, mintAirDrop: 1, minerDeposit: 2, /* others: 3 */ miningFees: 9, miningReward: 10 }
        const onChainSeq = {} // Create local onChainSeq object

        let mineTransactions = this.pending
            .filter(t => t.meta.txStake.startsWith(txStakeLabel + ':'))
            // .filter(t => t.timestamp < (time()-30))
            .slice()
            .sort((a, b) => (
                ((typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3)) ||
                (a.timestamp - b.timestamp) ||
                a.src.localeCompare(b.src) ||
                (a.seq - b.seq)
            ))
            .filter((t) => {
            const src = t.src
            const seq = Number(t.seq)
            if (!src.startsWith('_')) {
                if (!onChainSeq[src]) {
                    const srcWallet = this.ledger.getWallet(src)
                    onChainSeq[src] = srcWallet.onChain.seq
                }
                const nextSeq = Number(onChainSeq[src]) + 1
                if (seq === nextSeq) {
                    debug('green',`*** Queued for mining: ${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}  - onChainSeq[src](${onChainSeq[src]}) srcWallet.tx.seq(${this.ledger.getWallet(src).tx.seq})`)
                    onChainSeq[src]++
                    return true
                } else if(seq > nextSeq) {
                    debug('dim',`    ~~ delaying mining ${t.txStake?.split(':')[0] || ''} transaction ${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}: onChainSeq(${onChainSeq[src]}) as its not chronological`)
                    return false
                } else if(seq < nextSeq) {
                    debug('cyan',`    xx removing transaction ${src.split(':')[0]}/${seq} older than onChainSeq(${onChainSeq[src]}), will never be minted, so kill it! `)
                    const { error } = this.reverse(t)
                    if( error ) debug('dim', `     - ${error}` )
                    return false
                }
            }
            return true
        })

        if( !metaInclude )
            mineTransactions = mineTransactions.map( ({meta, ...data}) => data ) // remove TransactionManager meta data
        
        return mineTransactions.slice(0, maxTransactions)
    }

    deletePending({ hashes, timestamp = '' }){
        if( (!hashes && !timestamp) || this.pending.length < 1 ) return ''

        debug('cyan',`    ~ [deletePending] hashes(${hashes?.length || '0'}) timestamp(${timestamp||'-'}) this.pending(${this.pending.length})` )

        let deleteHashes = []
        if( hashes && hashes.length > 0 ){
            // BUGBUG this block is just debug
            deleteHashes = this.pending.filter( t => hashes.includes(t.hash) ).map( t => t.hash )
        } else if( timestamp ) {
            deleteHashes = this.pending.filter( t => t.timestamp < timestamp ).map( t => t.hash )
        }
        if( !deleteHashes || deleteHashes.length<1 ) return ''

        // now remove those delete ones
        this.pending = this.pending.slice().filter( t => !deleteHashes.includes(t.hash) )
        return deleteHashes.join(',')
    }    
}
