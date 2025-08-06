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

import Wallet from './Wallet.js'
import { urlCall, fixRounding, time, waitReady, debug } from './helper.js'

const MAX_PENDING_PER_USER = 16             // prevent user-spamming transactions, limit how many we accept in our pending list
const PENDING_TRANSACTION_STALE = 1200      // time after which we flush pending as stale

export class Mempool {
    static {
        this.hashes = {}
        this.queue = []
    }

    static load(){

    }

    static reset(){
        this.hashes = {}
        this.queue = []
            
    }

    // check if mempool entry exists, and it's still ONLY mempool (not written to a block [with an index])
    static exists( hash ){
        return this.hashes[hash]!== undefined
    }
    
    static reloadQueued(){
        return this.newBatch( this.queue )
    }

    static findBlockIndex(hash){
        if( !this.exists(hash) ) return false

        return this.hashes[hash]?.index || false
        // if( this.hashes[hash]?.index && this.hashes[hash].index > -1 )
        //     return this.hashes[hash].index
        // else
        //     return false
    }

    static updateHashBlockIdx( hash, idx ){
        if( this.hashes[hash] === undefined ) {
            // undefined, create it
            this.hashes[hash] = { index: idx, created: time() }

        } else if( this.hashes[hash].index === -1 && idx > -1 ){
            // was mempool, now block
            this.hashes[hash].index = idx

        } else if( this.hashes[hash].index > -1 && idx === -1 ){
            // we trying to put back into mempool, ignore.
            debug('dim', `  ! hash already on-block, ignoring mempool attempt (BUGBUG?)` )
            return { error: `Hash already on-block.`, index: this.hashes[hash].index }

        } else if( this.hashes[hash].index > -1 && this.hashes[hash].index !== idx ) {
            return { error: `Hash already used by ANOTHER transaction, this attempted hash update ignored.`, index: idx }

        }

        return true
    }

    static clearBlockIndex( hash ){
        this.hashes[hash].index = -1
    }    


    static filter(item = '',value = ''){
        if( item === '' )
            return this.queue
        else if( item === 'miner' )
            return this.queue.length && this.queue.filter( t => t.meta.miner === value).slice()
        else if( item === 'src' )
            return this.queue.length && this.queue.filter( t => t.src === value).slice()
    }

    static queueLen(item = '',value = ''){
        const queueItems = this.filter(item,value)
        if( queueItems.length>0 )
            return queueItems.length
        else
            return false
    }

    static addQueue( transactions ){
        let addCnt = 0
        for( const transaction of transactions ){
             // is hash already there?
            if( !this.exists(transaction.hash) ) continue

            // check user not spamming
            const srcCnt = Mempool.queueLen('src',transaction.src)
            if( srcCnt >= MAX_PENDING_PER_USER )
                return { error: `Sorry too many transactions (${srcCnt}) by user (${transaction.src}). Please resubmit later once blocks mined.` }

            else if( srcCnt > 0 )
                Mempool.filter('src',transaction.src).forEach( t => {
                    if( t.meta?.miner && t.meta.miner !== this.nodeName ) warning += `queued on ${t.meta.miner}; `
                    })

            transaction.meta.queueTime = time() // track the time we queued it in pending
            this.queue.push( transaction )
            // update the hash entry
            this.updateHashBlockIdx(transaction.hash,-1)
            debug('dim',`    -> +re-saving to mempool:    ${transaction.src.split(':')[0]}/${transaction.seq} -> ${transaction.dest.split(':')[0]} $${transaction.amount}` + (existsQueued ? `; hash:${transaction.hash} already pending, skipping re-adding` : ''))
            addCnt++
        }
        
        return addCnt
    }
    
    static getQueued({ ofMiner, maxTransactions, metaInclude=true }){
        // gather transactions to be mined --> those staked by us (BTC different -- tries to mine ANY transactions pending)
        // ASSUME: we are going with (likely valid) belief if there's a clump of user-transactions they coming from same server, 
        //         -> so timestamp will be exact for them relative to each other (don't want timestamp <> seq # to be off!)

        // issue..airdrop..deposit FIRST (as affect src liquidity), then other movements, and LAST miningFees and finally miningReward
        // technically miningFees/miningReward should NEVER be in transactions, as they are added at the time blocks are minted
              
        const typeOrder = { mintIssue: 0, mintAirDrop: 1, minerDeposit: 2, /* others: 3 */ miningFees: 9, miningReward: 10 }
        const onChainSeq = {} // Create local onChainSeq object

        let mineTransactions = this.filter('miner',ofMiner)
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
                if (!src.startsWith('_')) {
                    if (!onChainSeq[src]) {
                        onChainSeq[src] = Wallet.getUser(src).onChain.seq
                    }
                    const nextSeq = Number(onChainSeq[src]) + 1
                    if (seq === nextSeq) {
                        debug('green',`*** Queued for mining: [${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}] - onChainSeq[src](${onChainSeq[src]}) srcWallet.tx.seq(${Wallet.getUser(src).tx.seq})`)
                        onChainSeq[src]++
                        return true
                    } else if(seq > nextSeq) {
                        debug('dim',`    ~~ delaying mining ${t.meta?.miner || ''} transaction [${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}]: onChainSeq(${onChainSeq[src]}) as its not chronological`)
                        return false
                    } else if(seq < nextSeq) {
                        debug('cyan',`    xx removing transaction [${src.split(':')[0]}/${seq} -> ${t.dest.split(':')[0]} $${t.amount}] older than onChainSeq(${onChainSeq[src]}), will never be minted, so kill it! `)
                        const { error } = this.reverse(t)
                        if( error ) debug('dim', `     - ${error}` )
                        return false
                    }
                }
                return true
            })

        if( !metaInclude )
            mineTransactions = mineTransactions.map( ({meta, ...data}) => data ) // remove transactionHandler meta data
        
        return mineTransactions.slice(0, maxTransactions)
    }

    // delete( hash ){
    //     delete this.hashes[hash]
    // }

    static deleteQueue( hashes, timestamp = '' ){
        if( (!hashes && !timestamp) || this.queue.length < 1 ) return ''

        let deleteHashes = [], deleteTransactions = []
        if( hashes && hashes.length > 0 ){
            // BUGBUG this block is just debug
            deleteTransactions = this.queue.filter( t => hashes.includes(t.hash) )
            deleteHashes = deleteTransactions.map( t => t.hash )
        } else if( timestamp ) {
            deleteTransactions = this.queue.filter( t => t.queueTime < timestamp )
            deleteHashes = deleteTransactions.map( t => t.hash )
        }
        if( !deleteHashes || deleteHashes.length<1 ) return ''

        // DEBUG output
        debug('cyan',`    ~ [Mempool.delete()] hashes(${hashes?.length || '0'}) timestamp(${timestamp||'-'}) this.queue(${this.queue.length})` )
        deleteTransactions.forEach( t=>{
            debug( ( timestamp ? 'red' : 'dim' ),`      ~ [${t.src.split(':')[0]}/${t.seq} -> ${t.dest.split(':')[0]} $${t.amount}]/${t.type} ${timestamp ? `staled(${timestamp-t.queueTime})` : ''} -> deleted.`)
        })
        
        // now remove those delete ones
        this.queue = this.queue.slice().filter( t => !deleteHashes.includes(t.hash) )
        
        // any of these hashes that remain mempool and don't have an assigned block we remove hash (does this ever happen? chk... BUGBUG)
        for( const hash of hashes )
            if( this.hashes[hash].index === -1 ){
                debug('red',`    ~ YES this.hashes[${hash}].index = -1, so removing the hash! ` + deleteHashes.includes(hash) ? `(and already deleted matching transaction)` : `(but couldn't findmatching queue transaction)` )
                delete this.hashes[hash]
            }

        return deleteHashes.join(',')
    }
    
    static clearStale( forceSync = false ){
        // clear out stale pendingTransactions
        const staleHashes = this.deleteQueue( undefined, time()-PENDING_TRANSACTION_STALE )
        if( staleHashes || forceSync ){
            if( staleHashes ) debug('cyan',`   ~ Cleared stale pending transactions: ${staleHashes}`)
            // sync all wallets to chain-length
            this.syncToChain()
        }
    }

    static syncToChain(){
        if( Wallet.addresses.length<1 ) return
        // if there are no pending for a tx, it MUST be same as onChain, else we sync
        // this may be due to BUGBUG bugs in the system, as this shouldn't happen but it does
        // with complex intermeshed queries
        for( const publicKey of Object.keys(Wallet.addresses) ){
            const wallet = Wallet.getUser(publicKey)
            const transName = this.queue.length === 0 ? '' : Wallet.buildNameWithPublicKey(wallet.name,wallet.publicKey)
            const matchTransactions = this.queue.length === 0 ? [] : this.queue.filter(t => (t.src === transName || t.dest === transName) )
            // we only try to balance _mint when there are no pending, otherwise it could be a mined block in progress...
            if( this.queue.length === 0 || (transName !== '_mint' && matchTransactions.length === 0) ){
                if( wallet.tx.balance !== wallet.onChain.balance ){
                    debug( 'cyan', `   ~ [syncToChain] ${wallet.name} no pending but chain diff: tx.balance(${wallet.tx.balance}) onChain.balance(${wallet.onChain.balance}), sync to onChain value.`)
                    wallet.tx.amount = wallet.onChain.amount
                    wallet.tx.balance = wallet.onChain.balance
                    wallet.tx.seq = wallet.onChain.seq
                }
            }
        }
    }    
}

export default Mempool



