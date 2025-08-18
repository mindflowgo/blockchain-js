/**************************************************************************
 * Mempool Module
* 
* (c) 2025 Filipe Laborde, fil@rezox.com
* 
* MIT License
* 
* Because minting blocks takes time, we need another way to track the transactions 
* as they happen in real time, and this is where mempool comes in, it's a memory
* based list of all unprocessed (ie unblocked) transactions this miner knows about
*
* Because mempool needs to the hashes of all transactions to know where they are, and 
* if unprocessed, we also have a list of all the user/admin transaction hashes and which block they in
* ***********************************************************************/

import { fixRounding, time, waitReady, debug } from './helper.js'

const MAX_PENDING_PER_USER = 16             // prevent user-spamming transactions, limit how many we accept in our pending list
const PENDING_TRANSACTION_STALE = 1200      // time after which we flush pending as stale
const STALE_CHECK = 60

export class Mempool {
    constructor( Wallet ){ // pass wallet in for syncChainToTx, getUser, then in debugging getNameOnly
        // variables
        this.hashes = {}
        this.queue = []

        // classes this uses
        this.Wallet = Wallet

        // every minute check for stale pending and delete
        if( this.Wallet )
            setInterval(() => { this.purgeStale( time()-PENDING_TRANSACTION_STALE ) }, STALE_CHECK * 1000)
    }

    reset(){
        this.hashes = {}
        this.queue = []
            
    }

    // empty queue, try miner coin sync | else look for stale transactions and sync those users
    purgeStale( purgeSince ){
        // if queue empty, we attempt to sync coins
        if( this.queue.length === 0 ){
            this.Wallet.syncTxToChain( [], true ) // pass-thru to TransactionHandler.syncTxToChain
            return
        }

        // if queue not empty, we try to delete stale ones and sync their accounts
        const { hashes, transactions } = this.deleteQueue( undefined, purgeSince )
        if( transactions.length<1 ) return

        debug('cyan',`   ~ Cleared stale pending transactions: ${hashes}, queue transactions removed:`, transactions)
        // lets track how many other queue entries exist for wallet sync decisions 
        const addresses = {}
        for( const t of transactions ) {
            const queueTransactionCnt = this.queue.filter(q => 
                (q.src === t.src || q.dest === t.dest) && 
                q.token === t.token).length
            // we only allow purging if no pending queue items for that user
            if( queueTransactionCnt > 0 ) continue

            if( !addresses.src ) addresses.src = []
            if( !addresses.dest ) addresses.dest = []
            // now add this token to it's list
            // addresses { name1: [ USDC, USDB ] }
            if( !addresses.src.includes(token) ) addresses.src.push( token )
            if( !addresses.dest.includes(token) ) addresses.dest.push( token )
        }
        // for these deleted queue entries, we revert TX to onChain value
        this.Wallet.syncTxToChain( addresses ) // pass-thru to TransactionHandler.syncTxToChain
    }

    // check if mempool entry exists, and it's still ONLY mempool (not written to a block [with an index])
    exists( hash ){
        return this.hashes[hash]!== undefined
    }
    
    findHashBlockIndex(hash){
        if( !this.exists(hash) ) return false

        return this.hashes[hash]?.index || false
        // if( this.hashes[hash]?.index && this.hashes[hash].index > -1 )
        //     return this.hashes[hash].index
        // else
        //     return false
    }

    updateHashBlockIdx( hash, idx ){
        if( !this.exists(hash) ) {
            // undefined, create it
            this.hashes[hash] = { index: idx, created: time() }

        } else if( this.findHashBlockIndex(hash) === -1 && idx > -1 ){
            // was mempool, now block
            this.hashes[hash].index = idx

        } else if( this.findHashBlockIndex(hash) > -1 && idx === -1 ){
            // we trying to put back into mempool, ignore.
            debug('dim', `  ! hash already on-block, ignoring mempool attempt (BUGBUG?)` )
            return { error: `Hash already on-block.`, index: this.findHashBlockIndex(hash) }

        } else if( this.findHashBlockIndex(hash) > -1 && this.findHashBlockIndex(hash) !== idx ) {
            return { error: `Hash already used by ANOTHER transaction, this attempted hash update ignored.`, index: idx }

        }

        return true
    }

    clearHashBlockIdx( hash ){
        this.hashes[hash].index = -1
    }

    filter(item = '',value = ''){
        if( item === '' )
            return this.queue
        else if( item === 'miner' )
            return this.queue.length && this.queue.filter( t => t.meta?.miner === value ).slice()
        else if( item === 'src' )
            return this.queue.length && this.queue.filter( t => t.src === value).slice()
    }

    queueLen(item = '',value = ''){
        console.log( `[queueLen] item(${item}) value(${value})`)
        const queueItems = this.filter(item,value)
        if( queueItems.length>0 )
            return queueItems.length
        else
            return false
    }

    addQueue( transactions ){
        let addCnt = 0
        for( const transaction of transactions ){
             // is hash already there?
            if( this.exists(transaction.hash) ){
                debug('dim',`    -> +re-saving to mempool:[addQueue]   ${this.Wallet.getNameOnly(transaction.src) || transaction.src}/${transaction.seq} -> ${this.Wallet.getNameOnly(transaction.dest) || transaction.dest} [${transaction.token}]${transaction.amount}; hash:${transaction.hash} already pending, skipping re-adding` )
                continue
            }

            // check user not spamming
            const srcCnt = this.queueLen('src',transaction.src)
            if( srcCnt >= MAX_PENDING_PER_USER ) {
                return { error: `Sorry too many transactions (${srcCnt}) by user (${transaction.src}). Please resubmit later once blocks mined.` }

            }
            
            this.queue.push( transaction )
            
            // update the hash entry
            this.updateHashBlockIdx(transaction.hash,-1)
            debug('dim',`    -> [Mempool::addQueue]   ${this.Wallet.getNameOnly(transaction.src) || transaction.src}/${transaction.seq} -> ${this.Wallet.getNameOnly(transaction.dest) || transaction.dest} [${transaction.token}]${transaction.amount}`, this.queue )
            addCnt++
        }

        return addCnt
    }
    
    getQueued({ miner, maxTransactions }){
        // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
        // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
        //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)

        // issue..airdrop..deposit FIRST (as affect src liquidity), then other movements, and LAST miningFees and finally miningReward
        // technically miningFees/miningReward should NEVER be in transactions, as they are added at the time blocks are minted
        const typeOrder = { tokenIssue: 0, tokenAirDrop: 1, minerDeposit: 2, /* others: 3 */ miningFees: 9, miningReward: 10 }
        const onChainSeq = {} // Create local onChainSeq object

        // no miner, get all entries (BUGBUG do we use this?)
        if( miner === undefined )
            return maxTransactions ? this.queue : this.queue.slice(0, maxTransactions)
        
        let mineTransactions = this.filter('miner',miner)
            // .filter(t => t.timestamp < (time()-30))
            // .slice()
            .sort((a, b) => (
                ((typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3)) ||
                (a.timestamp - b.timestamp) ||
                a.src.localeCompare(b.src) ||
                (a.seq - b.seq)
            ))
            .filter((t) => {
                // only pull sequential items for each user, delay any out of order
                const src = t.src
                const seq = Number(t.seq)
                if (!src.endsWith('$')) {
                    if (!onChainSeq[src]) {
                        onChainSeq[src] = this.Wallet ? this.Wallet.getUser(src).seq.onChain : 0 // only if this.Wallet object passed in
                    }
                    const nextSeq = Number(onChainSeq[src]) + 1
                    if (seq === nextSeq) {
                        debug('green',`*** Queued for mining: [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(t.dest)} ${t.token}${t.amount}] - onChainSeq[src](${onChainSeq[src]}) srcWallet.seq.tx(${this.Wallet.getUser(src).seq.tx})`)
                        onChainSeq[src]++
                        return true
                    } else if(seq > nextSeq) {
                        debug('dim',`    ~~ delaying mining ${t.meta?.miner || ''} transaction [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(t.dest)} ${t.token}${t.amount}]: onChainSeq(${onChainSeq[src]}) as its not chronological`)
                        return false
                    } else if(seq < nextSeq) {
                        debug('cyan',`    xx removing transaction [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(t.dest)} ${t.token}${t.amount}] older than onChainSeq(${onChainSeq[src]}), will never be minted, so kill it! `)
                        const { error } = this.reverse(t)
                        if( error ) debug('dim', `     - ${error}` )
                        return false
                    }
                }
                return true
            })

        // mineTransactions = mineTransactions.map( ({meta, ...data}) => data ) // remove transactionHandler meta data
        return mineTransactions.length <= maxTransactions ? mineTransactions : mineTransactions.slice(0, maxTransactions)
    }

    // delete( hash ){
    //     delete this.hashes[hash]
    // }

    deleteQueue( hashes, timestamp = '' ){
        if( this.queue.length < 1 ) return { error: "Empty queue" }

        let deleteHashes = [], deleteTransactions = []
        if( hashes && hashes.length > 0 ){
            // BUGBUG this block is just debug
            deleteTransactions = this.queue.filter( t => hashes.includes(t.hash) ).slice()
        } else if( timestamp ) {
            deleteTransactions = this.queue.filter( t => t.meta.queueTime < timestamp ).slice()
        } else {
            return { error: "No hash/timestamp given"}
        }

        deleteHashes = deleteTransactions.map( t => t.hash )
        if( !deleteHashes || deleteHashes.length<1 ) return ''

        // DEBUG output
        debug('cyan',`    ~ [Mempool.delete()] hashes(${hashes?.length || '0'}) timestamp(${timestamp||'-'}) this.queue(${this.queue.length})` )
        deleteTransactions.forEach( t=>{
            debug( ( timestamp ? 'red' : 'dim' ),`      ~ [${this.Wallet.getNameOnly(t.src)}/${t.seq} -> ${this.Wallet.getNameOnly(t.dest)} $${t.amount}]/${t.type} ${timestamp ? `staled(${timestamp-t.queueTime})` : ''} -> deleted.`)
        })
        
        // now remove those delete ones
        this.queue = this.queue.slice().filter( t => !deleteHashes.includes(t.hash) )
        
        // any of these hashes that remain mempool and don't have an assigned block we remove hash (does this ever happen? chk... BUGBUG)
        for( const hash of hashes )
            if( this.hashes[hash].index === -1 ){
                debug('red',`    ~ YES this.hashes[${hash}].index = -1, so removing the hash! ` + deleteHashes.includes(hash) ? `(and already deleted matching transaction)` : `(but couldn't findmatching queue transaction)` )
                delete this.hashes[hash]
            }

        return { error: false, hashes: deleteHashes, transactions: deleteTransactions }
    }
}

export default Mempool



