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
        // no hash means it MUST be new
        if( !hash || hash.length<43 ) return { error: false, isNew: true, index: -1 }

        const isNew = this.hashes[hash] === undefined
        
        if( isNew ){
            // create entry (-1 = pending, no assigned block)
            this.hashes[hash] = { index: blockIdx, created: time() }
        } else if(  blockIdx > -1 ){
            const trans = this.hashes[hash]

            if( trans.index === -1 ){
                // converting from pending (-1) to block #
                trans.index = blockIdx
            } else if( trans.index !== blockIdx ){
                debug( 'red', `**STRANGE** Two transactions with same hashes: blockIdx(${blockIdx}) but hash has: #${trans.index} `)
                // trans.index += ',' + blockIdx
                return { error: `Attempting to create same hash with different block, not allowed`, index: trans.index }
            }
        } else {
            // hash already exists, yet it's a mempool (-1) creation request - duplicate!
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
    
    reloadPending(){
        return this.newBatch( this.pending )
    }

    newBatch( _transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false }= options

        // run ledger transaction & add to hash list
        let newHashes = [], hashes = [], result = [], error = '', transactionCnt = 0

        if( blockIdx>-1 ) debug('cyan',`\n- [newBatch] [block#${blockIdx}]: (transactions: ${_transactions.length}) ------------------------------------------------------------------------` )
        for( const _transaction of _transactions ){
            const transaction = this.new(_transaction, { blockIdx, txUpdate })
            hashes.push( _transaction.hash || transaction.hash )
            result.push( transaction ) // includ transaction.error results
            if( transaction.error ){
                if( transaction?.index<0 ){
                    // failed so delete reference to this transaction hash
                    debug( 'dim', `   .. ${transaction.error} (Failed transaction; deleting hash)`)
                    delete this.hashes[_transaction.hash]
                    hashes.pop() // slice(0,-1)
                    error += transaction.error + ','
                } else {
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
                // verify there are excess pending from this src, reject it
                const transSrc = this.ledger.buildTransactionName(src, srcWallet.publicKey)
                const pendingSrcCnt = this.pending.filter( t => t.src === transSrc ).length
                if( pendingSrcCnt >= MAX_PENDING_PER_USER ) {
                    return { error: `Sorry too many transactions (${pendingSrcCnt}) by user (${src}). Please resubmit later once blocks mined.` }
                }
                fee = this.getFee({ amount, fee })
            }

            // issue a stake request as it came through us
            if( !data.meta ) data.meta = {}
            if( !data.meta.txStake ) data.meta.txStake = `${this.nodeName}:${time()}`

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
                        if( !testOnly) this.ledger.transaction({src, dest, amount, fee, seq, txSig, hash, ...data}, { blockIdx, txUpdate, reverse: true })
                        return error
                    }
                }

                data.meta.balance = blockIdx === -1 ? srcWallet.tx.balance : srcWallet.onChain.balance

                // queue in pending if not already in a block
                if( blockIdx === -1 )
                    this.addPending( transaction )
                
                debug('dim',`     \\ new, processed ledger transaction` 
                            + (hash !== transaction.hash ? '; created hash!' : '') 
                            + (blockIdx === -1 ? '; added pending' : '') )
            } else {
                debug('dim',`     \\ test-only transaction` )
            }

        } else if( index > -1 ){
            // not new, so likely was a mempool, now converted to a block entry
            transaction = { error: `Cannot create new transaction: rather updated wallet.onChain & transactionHash: block = #${index}${data.seq > 0 ? `; onChain(${data.seq})` : '' }`, updateSeq: true, index }
            
            // update ledger to reflect it's onChain (add value + update seq)
            // ***************** re-think
            // transaction hash already exists, so mempool tx updated; we just want to update the onChain values...
            if( !testOnly ){ 
                const result = this.ledger.transactionWalletUpdate({ src, dest, amount, fee, seq, blockIdx })
                if( result.error ) return result
            }
            // debug( `     . not new; ledger already reflects transaction, updated block#(${index}) in transactionHash `)
        } else {
            debug( 'red', `[blockchain::transaction] Should NOT come here: hash(${data.hash} blockIdx(${blockIdx}))`)
            transaction = { error: `Should NOT come here: hash(${data.hash} blockIdx(${blockIdx})`, index }
        }

        return transaction //{ ...transaction, balance: srcWallet.tx.balance  }
    }



    transactionReverse2({src, amount, fee, ...data}, options = {}) {
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
            delete this.hashes[data.hash]
        }

        return reverseTransaction
    }

    
    // 2 modes of use:
    // no 'clearPending': will uncommit pending from a block OR revert transaction if no pending
    // with clearPending: fully nuke transaction regardless, pending included
    reverse({src, dest, amount, fee, seq, hash, ...data}, options = {}) {
        const { clearPending = false } = options
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}
        
        // is it already in hash tracker?
        const { error, isNew, index }= this.findOrCreateHash( hash, -1 )
        if( error ) return error
        if( isNew ) return { error: `Non-existant transaction, nothing to reverse.` }

        if( index === -1 && clearPending ){
            this.pending = this.pending.filter( t => t.hash !== hash )
            delete this.hashes[hash]
            debug('dim', `    ~ removed pending entry; and removed hash. Now reversing ledger values.`)
        }
        // if( index === -1 ){
        debug('dim',`  ~ reversing hash(${hash}) >> index(${index})`)
        return this.ledger.transaction({src, dest, amount, fee, seq, hash, ...data}, { blockIdx: index, txUpdate: true, reverse: true })

        // }
        /*
        // if it has a pending, we revert to that, else we actually erase
        // debug( 'dim', `[transactionReverse] hash(${hash})`)
        const pendingIdx = this.pending.findIndex( t => t.hash === hash )
        if( clearPending ){
            console.log( `hash(${hash}), hashes:`, this.blockchain.hashes )
            if( this.blockchain.hashes ) delete this.blockchain.hashes[hash]
            if( pendingIdx > -1 ) this.pending.splice(pendingIdx,1)

            const result = this.blockchain.transactionReverse({hash, ...data}, options)
            return result

        } else {
            if( pendingIdx > -1 ){
                debug('dim',` \.. found pending, resetting transactionHash: -1`)
                if( this.blockchain.hashes[hash] !== undefined )
                    this.blockchain.hashes[hash].index = -1
                return { error: false, hash, transHashCleared: this.blockchain.hashes[hash] !== undefined }
            } else {
                // debug('dim',` \.. no pending, fully reversing it`)
                const result = this.transactionReverse2({hash, ...data}, options)
                return result
            }
        }
            */
    }

    reverseBatch( transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false } = options

        let pending = 0, deleted = 0

        transactions.forEach( t => {
            // we do blockchain.transactionReverse as we do not want to remove from pending, will try again, new block#!
            const result = this.reverse(t, { blockIdx, txUpdate })
            console.log( ` [reverse] `, result)
            if( result.error )
                debug('red', result.error )
            else if( result.transHashCleared ) 
                pending++
            else
                deleted++
        })
        return { pending, deleted }
    }

    pendingCnt(txStakeLabel){
        if( txStakeLabel )
            return ( this.pending.filter( t => t.meta.txStake.startsWith(txStakeLabel+':')) ).length
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

    deletePending({ hashes, timestamp = '', reverse = false }){
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

        debug( 'green', `[deletePending] hashes:`)
        if( reverse ){
            // first let's reverse these transactions
            const transactions = this.pending.filter( t => deleteHashes.includes(t.hash) )
            const result = this.reverseBatch(transactions) //t, {clearPending: true})
            if( result.error ) return result
        }

        // now remove those delete ones
        this.pending = this.pending.slice().filter( t => !deleteHashes.includes(t.hash) )
        return deleteHashes.join(',')
    }    
}
