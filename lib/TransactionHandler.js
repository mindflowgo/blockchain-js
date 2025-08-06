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

import Wallet from './Wallet.js'
import Mempool from './Mempool.js'
import Crypto from './Crypto.js'

import { fixRounding, time, waitReady, debug } from './helper.js'


const GENESIS_ISSUE = 1000000000        // coin-pool size established at genesis

// min/max # of user/admin -- ie non-system generated tarnsactions (reward, fees, etc)
const BLOCK_MIN_TRANSACTIONS = 1
const BLOCK_MAX_TRANSACTIONS = 10
const BLOCK_TRANSACTION_TYPES_USER = ['minerDeposit','transfer'] // valid user transaction types
const BLOCK_TRANSACTION_TYPES_ADMIN = ['mintIssue','mintAirDrop']
const BLOCK_TRANASCTION_TYPES_SYSTEM = ['miningReward', 'miningFees']
const TRANSACTION_TYPES = [...BLOCK_TRANSACTION_TYPES_USER, ...BLOCK_TRANSACTION_TYPES_ADMIN, ...BLOCK_TRANASCTION_TYPES_SYSTEM]

const TRANSACTION_FEE_PERCENT = 1           // commission 1%
const TRANSACTION_FEE_CAP = 100             // most to charge ($)

// Miner Class =================================================================================
export default class TransactionHandler {
    // This block runs once to perform the setup.
    static {
        this.nodeName = ''
    }

    static init({ nodeName }) {
        this.nodeName = nodeName

        debug( 'green', `transactionHandler: transaction fee: ${TRANSACTION_FEE_PERCENT}% ${TRANSACTION_FEE_CAP > 0 ? `, fee cap (${TRANSACTION_FEE_CAP})` : ''}`)
    }

    static getFee({ amount, fee=0 }){
        // transaction occurs in Ledger, but we contribute the fee our miner charges here
        // users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        //  miner can override upward the fee        
        if( fee<0 ) fee = 0
        fee = fixRounding( Math.max(fee, Number(amount || 0) * TRANSACTION_FEE_PERCENT/100) )
        if( TRANSACTION_FEE_CAP > 0 )
            fee = Math.min(TRANSACTION_FEE_CAP, fee)
        return fee
    }
    
    static finalizeTransactions( block ) {
        if( block.transactions.length < 1 ) return false

        // clean-up transactions (remove meta data) to add to it - anything we dont want stored in blockchain in
        block.transactions = block.transactions.map( ({meta, ...data})=> data )

        // build merkle tree, grab the root value
        const merkleTree = TransactionHandler.merkleBuild( block.transactions )
        block.merkleRoot = merkleTree.pop()[0]

        // calculate final hash
        block.hash = block.calcHash()

        return true
    }

    static calcHash(transaction) {
        // clone transaction before removing fields, otherwise pass-by-reference problems!
        const _transaction = { ...transaction }

        // we include ALL transaction fields in hash, except:
        // - non-transaction mining metadata excluded (meta)
        // - signature that is DONE on this hash, thus depends on it
        // - hash itself
        delete _transaction.meta
        delete _transaction.txSig
        delete _transaction.hash
        // Ethereum and some other blockchains use Keccak-256 as it has better protection against quantum computing
        // But sha256 is strong used by BTC and similar ecosystems - encode bs58 to make it shorter with alpha chars vs hex
        return Crypto.hash(_transaction)
    }

    // user starting with '_' are admin users, '_' is placeholder for ecosystem creator of tokens
    // which we first send to the _mint of that token which then uses them
    static buildGenesisTransactions(supply = GENESIS_ISSUE, token = ''){
        const transactionData = { src: '_', dest: '_mint', amount: supply, token, type: 'mintIssue', timestamp: token === '' ? 0 : time() }
        const genesisTransaction = this.buildTransaction(transactionData)
        // returning genesis gransactions initialized
        return [ genesisTransaction ]
    }

    // build Merkle using base58 entries
    static merkleBuild(transactions) {
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
                newLevel.push( Crypto.hashJoinTwo(currentLevel[i],currentLevel[i + 1]) )
            }

            layers.push(newLevel)
        }
        return layers
    }

    // Generate the Merkle Proof for a specific transaction
    // Verify in ledger.js
    static merkleProof(transactions, txHash) {
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

    static merkleVerify(hash, proof, merkleRoot) {
        // loop through and compound hashes, proof setup to allow this
        for (let i = 0; i < proof.length; i++) {
            // follow buildMerkleProof arbitrary choice: smaller hash first, consistent order
            hash = Crypto.hashJoinTwo(hash,proof[i])
        }

        return hash === merkleRoot
    }

    // Find unique src/dest user list in the transactions provided
    static findUsers( transactions ){
        const users = {}
        for( const t of transactions ){
            users[t.src] = 1; users[t.dest] = 1
        }
        return Object.keys(users)
    }

    static checkTransactionCount(transactions) {
        let transactionCnt = 0
        // calc how many user transactions in block, we have blockchain limits (to prevent niners from skimping to get more credit, etc)
        for( const transaction in transactions )
            if( BLOCK_TRANSACTION_TYPES_USER.includes(transaction.type) || BLOCK_TRANSACTION_TYPES_ADMIN.includes(transaction.type) )
                transactionCnt++

        if( transactionCnt>0 && transactionCnt >= BLOCK_MIN_TRANSACTIONS && transactionCnt <= BLOCK_MAX_TRANSACTIONS ) 
            return transactionCnt
        else
            return { error: `Need min:${BLOCK_MIN_TRANSACTIONS}/max:${BLOCK_MAX_TRANSACTIONS} user transactions per block, found: ${transactionCnt || '-'}. Rejecting.` }
    }    

    // check transactions are all signed, and seq ok
    static auditTransactions(blockMiner, blockIdx, transactions, expectedMiningReward) {
        let miningReward = 0, miningFees = 0, transactionCnt = 0, adminCnt = 0, transactionError = false

        // genesis block we just accept
        if( blockIdx === 0 ) return { error: false, transactionCnt: 0, adminCnt: transactions.length, miningFees: 0 }

        const validTransactionCnt = this.checkTransactionCount(transactions)
        if( validTransactionCnt.error ) return validTransactionCnt

        // gather all wallets as we're doing a dry run through transactions
        // then snapshot them as we'll be changing the values in them simulating adding
        // all these transactions, making sure we don't run into negative values, etc.
        const transactionUsers = this.findUsers(transactions)
        debug( 'in checkin 2')
        Wallet.userSnapshots( transactionUsers )
        debug('dim',`-- wallet snapshot --\\\\`)
        Wallet.debugOutputLevel = 0 // don's show output while usingit
        debug( 'in checkin 2.5')
        for( const transaction of transactions ){
            // check transaction itself (signing, balances) by doing it
            const newTransaction = this.buildTransaction(transaction,{ blockIdx: block.index, txUpdate: true })
            if( newTransaction.error ) transactionError = newTransaction.error
            // update wallet balances - if txUpdate true it will do wallet tx at same time as onChain
            //!change all transaction() -> buildTransaction()
            //! add in the walletUpdate() after the buildTransactions()
            this.walletTransactionData({ ...newTransaction, blockIdx: block.index, txUpdate: true })

            // check integrity of block structure - return error if not specific allowed types
            if( transaction.type === 'miningReward' ){
                // one mining reward per block
                if( transaction.dest.startsWith(blockMiner+':') && transaction.amount == expectedMiningReward && miningReward < 2 ){
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
            } else if( BLOCK_TRANSACTION_TYPES_USER.includes(transaction.type )){
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
        if( miningReward !== transactions.length )
            transactionError = `Block miningReward claims wrong: expecting one miningReward for each of the ${transactions.length} transactions. Rejecting.`
        debug( 'in checkin 3')
        Wallet.userRestores( transactionUsers )
        Wallet.debugOutputLevel = 1
        debug('dim',`-- wallet restore --//`)
        // an object with transaction error will be returned, else simply false
        if( transactionError ) 
            return transactionError
        else
            return { error: false, transactionCnt, adminCnt, miningFees }

    }

    // when chains confliect, we keep our transactions to attempt rechaining later (dropping system ones)
    static filter({ transactions, hashes = [], types = [] }) {
        // organize list of transaction types we want to filter by
        let typeList = []
        if( typeof(types) === 'string' ) types = types.split(',').filter(s => s != '')
        if( types.includes('user') ) typeList.concat( BLOCK_TRANSACTION_TYPES_USER )
        if( types.includes('admin') ) typeList.concat( BLOCK_TRANSACTION_TYPES_ADMIN )
        if( types.includes('system') ) typeList.concat( BLOCK_TRANSACTION_TYPES_ADMIN )
        
        let filteredTransactions = []
        for( const transaction of transactions ){
            // determine if transaction user/admin-generated (transfer, airdrop, etc) or system generated
            if( hashes.length === 0 && !typeList.includes(transaction.type) ) continue 
            // if hash specified but not this one, we skip over            
            if( hashes.length > 0 && !hashes.includes(transaction.hash) ) continue

            transaction.meta = { miner: this.nodeName, minerReAdded: time() }
        
            filteredTransactions.push( transaction )
        }
        return filteredTransactions
    }

    // takes a transaction, and passes back with txSig + updated hash
    static transactionSign({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}){
        // build transaction
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )

        const newTransaction = { timestamp: time(), src, dest, amount, fee, type, seq, ...data } // exclude txSig, hash, meta from transaction 
        // we are signing as of how, hence timestamp updated, and then generate fresh hash (that we sign to prove we accepted this)
        const newHash = this.calcHash(newTransaction)
        if( hash !== '' && hash !== newHash ){
            if( this.debugOutputLevel ) debug('red',` [transactionSign] Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.`, newTransaction )
            return { error: `Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.` }
        }

        // transaction signing requires:
        //   a) signing-exempt admin-level account on node (starts with _)
        //   b) supplied external valid txSig
        //   c) node having src wallet with privateKey (node generates txSig)
        if( src.startsWith('_') ) { //a)
            // admin-level src, signing-exempt

        } else if( txSig ){ // b)
            // verify the sig given is valid
            const decodedHash = Wallet.decode(src, txSig)
            if( decodedHash !== newHash ){
                if( this.debugOutputLevel ) debug('red',` xx Signature was INVALID, rejecting transaction.`)
                return { error: `Transaction signature was INVALID, rejecting.` }
            }

        } else { // c)
            // wasn't signed, BUT we have the private key, so we assume it's from a sanctioned system, we'll sign it
            txSig = Wallet.sign(src, newHash) 
        }

        if( txSig ) newTransaction.txSig = txSig
        newTransaction.hash = newHash

        return newTransaction
    }

    // builds transaction (mostly in the transactionSign() method), checks seq is ok
    static buildTransaction({src, dest, amount, token = '', fee = 0, type = '', seq = 0, txSig = '', hash = '', meta, ...data}, options = {}){
        const { blockIdx = -1, txUpdate = false, reverse = false }= options
        // all other transaction fields don't affect us, so include directly
        let newTransaction

        if( reverse ){
            amount = -amount
            fee = -fee
        }

        src = Wallet.buildNameWithPublicKey(src)
        if( src.error ) return src
        dest = Wallet.buildNameWithPublicKey(dest)
        if( dest.error ) return dest


        // signed ok; now check ifs has src has balance (if non-admin user)
        const srcWallet = Wallet.getUser(src)
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        
        // type must be valid
        if( !TRANSACTION_TYPES.includes(type) ){
            return { error: `Unknown transaction type(${type}); hash(${hash}): choices(mintAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( reverse ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            newTransaction = { timestamp: time(), src, dest, amount, token, fee, type: `reversal:${type}`, hash: '', source: hash,  ...data }

        } else {
            // determine SEQ ----------
            if( src.startsWith('_') )
                seq = 0 // admin-level don't need signing, and will be attributed for in parallel on many nodes, leave seq = 0
            else if( seq < 1 ) 
                seq = srcWallet.tx.seq + 1 // auto-gen it as it doesn't need signed trans with seq (ex admins)
            else {
                // we need a seq that is valid and +1 on tx or onChain (depending on if trans is being done for writing block or just mempool)
                // SIGNING REQUIRED (seq NEEDED!) -- TODO should queue it up and look later (ex. if out of order), for onChain know that trans related to a block?
                // debug( 'green', `[ledger::transaction] (${srcWallet.name}/${seq}) blockIdx(${blockIdx}) trans-seq(${seq}) tx.seq(${srcWallet.tx.seq}) onChain.seq(${srcWallet.onChain.seq}) `)
                if( blockIdx === -1 && seq !== (srcWallet.tx.seq + 1) )
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${dest.split(':')[0]||dest} ${token}$${amount} rejected - need seq = srcWallet.tx.seq+1(${srcWallet.tx.seq+1})...`, 
                            blockIdx, seq: srcWallet.tx.seq, balance: Number(srcWallet.tx.balance) }
                else if( blockIdx > -1 && seq !== (srcWallet.onChain.seq + 1) )
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${dest.split(':')[0]||dest} ${token}$${amount}] rejected - block#${blockIdx}; need seq = onChain.seq+1(${srcWallet.onChain.seq+1})..`, 
                            blockIdx, seq: srcWallet.onChain.seq, balance: Number(srcWallet.onChain.balance) }
            } 
                 
            // SIGN IT (attempt at least) using seq determined above
            newTransaction = this.transactionSign({src, dest, amount, token, fee, type, seq, txSig, hash, ...data})

            if( newTransaction.error ) return newTransaction
            // check ledger balance sufficient (genesis issuer '_' excluded)
            if( src === '_' ) {
                debug('dim',`    ~ Mint Issue Transaction for: $${amount}`)

            } else if( blockIdx === -1 && Number(srcWallet.tx.balance) < (amount+fee) ){
                return { error: `${src.split(':')[0]} balance(${srcWallet.tx.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet.tx.balance) }

            } else if( blockIdx > -1 && Number(srcWallet.onChain.balance) < (amount+fee) ){
                return { error: `${src.split(':')[0]} onChain balance(${srcWallet.onChain.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet.onChain.balance) }
            }

            // update balance for meta data passed back (non-commital value), but not used for internal calculations
            // const balance = fixRounding((blockIdx === -1 ? srcWallet.tx.balance : srcWallet.onChain.balance) - (amount+fee))
            // this.updateMeta( [newTransaction], 'balance', balance)
        }

        if( this.debugOutputLevel ){
            debug('cyan',`  ~ #${blockIdx}:transaction${reverse?' *REVERSED*':''} [${src.split(':')[0]}${seq>0 ?'/'+seq:''}${srcWallet.privateKey?'[Signed]':''}`
                        +` -> ${dest.split(':')[0]||dest} ${token}$${amount}] / ${newTransaction.type || ''} `+( fee ? `fee(${fee}) `  : '') + (txUpdate ? '[txUpdate]' : '' ) 
                        + (seq>0 || srcWallet.tx.seq>0 || srcWallet.onChain.seq>0 ? ` seq(${seq}) tx.seq(${srcWallet.tx.seq}) onChain.seq(${srcWallet.onChain.seq})` : '') )
            //filter( item=>[src,dest].includes(item.name) ).
            Wallet.balances([src,dest])
        }
        return newTransaction
    }

    // update the wallet values
    // if a block#, does onChain; if no block# does tx; if block# + txUpdate, does BOTH
    static walletTransactionData({ src, dest, amount, token, fee, seq, blockIdx = -1, txUpdate = false, reverse = false }) {
        // update ledger balances
        // ---------------------- 
        let result, tx, onChain

        amount = fixRounding( Number(amount || 0) )
        fee = fixRounding( Number(fee || 0) )

        // MINT: redeposit fee into mint >> will be credited to a miner when block minted with transaction
        const walletAmount = [-(amount+fee), amount, fee]
        const walletAddresses = fee !== 0 ? [src, dest, '_mint'] : [src, dest]
        let idx=0
        for( const walletAddress of walletAddresses ){
            const wallet = Wallet.getUser(walletAddress)
            tx = wallet.tx || { seq: 0, amount: 0, balance: 0 }
            onChain = wallet.onChain || { seq: 0, amount: 0, balance: 0, historyIdx: [] }

            // if blockIdx -1: transaction mempool only; else onChain, and if it wasn't mempool'd first, we update mempool tally (txUpdate:true)
            if( blockIdx > -1 ) {
                onChain.amount = walletAmount[idx]
                onChain.balance = fixRounding( onChain.balance + onChain.amount )
                if( !reverse ){
                    if( !onChain.historyIdx.includes(blockIdx) ) onChain.historyIdx.unshift(blockIdx) // prepend block
                    if( idx===0 ){ // for transaction src, we manage seq
                        onChain.seq = (seq ?? 0)
                        tx.seq = Math.max(tx.seq, onChain.seq)
                    }
                } else {
                    // BUGBUG REVIEW LOGIC: assumes all transactions in that block will be reversed, so removes block
                    if( onChain.historyIdx.includes(blockIdx) ) onChain.historyIdx.shift() 
                    if( idx===0 ){
                        onChain.seq = Math.max(onChain.seq - 1, 0)
                        tx.seq = Math.max(tx.seq - 1, onChain.seq, 0)
                    }
                }
                onChain.historyIdx = onChain.historyIdx.slice(0,10) || []
                if( txUpdate ){ // mirror onto the tx balance (ex. on chain rel)
                    tx.amount = walletAmount[idx]
                    tx.balance = fixRounding( tx.balance + tx.amount )
                }
            } else {
                tx.amount = walletAmount[idx]
                tx.balance = fixRounding( wallet.tx.balance + tx.amount )
                if( !reverse ){
                    if( idx===0 ) tx.seq = Math.max(seq ?? 0, onChain.seq, 0)
                } else {
                    if( idx===0 ) tx.seq = Math.max(tx.seq - 1, onChain.seq, 0)
                }
            }

            result = Wallet.update( walletAddress, { onChain, tx })
            // debug(this.debugOutputLevel ? 'green' : 'dim', `        ${walletAddress.split(':')[0]} +tx(${wallet.tx.amount})=(${wallet.tx.balance}) +chain(${wallet.onChain.amount})=(${wallet.onChain.balance})`)
            if( result.error ) return result
            idx++
        }
        return { error: false }
    }

    // prepare a transaction for miner (so adjust pending layer too)
    static new({src, dest, amount, token, fee = 0, seq = 0, txSig = '', hash = '', ...data}, options = {} ) {
        const { blockIdx = -1, txUpdate = false, testOnly = false }= options
        // Validate transaction
        if (!src || !dest || !amount) {
            debug('red',`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            return { error: `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` }
        }

        // no hash -> new; hash but not in hashes -> new
        const isNew = !hash ? true : Mempool.exists(hash)
        
        let transaction
        let warning = data.meta?.warning || '' // pre-set warning with any prior meta-data from it
        if( isNew ){
            // system users (_) no fees, others pay fees
            fee = src.startsWith('_') ? 0 : this.getFee({ amount, fee })

            const transactionData = {src, dest, amount, token, fee, seq, txSig, hash, ...data}
            transaction = this.buildTransaction(transactionData,{ blockIdx, txUpdate, testOnly })
            if( transaction.error ) {
                transaction = { error: transaction.error, index: blockIdx }

            } else if( testOnly ) {
                debug('dim',`     \\ test/automated-only transaction` )
                return transaction
            }

            // MEMPOOL
            if( blockIdx === -1 ){
                // no mempool entry, and we're just queuing it
                // if( !transaction.meta ) transaction.meta = {}
                const addCnt = Mempool.addQueue( [transaction] )
                if( addCnt.error ) return addCnt

            } else {
                const updateResult = Mempool.updateHashBlockIdx(transaction.hash,blockIdx)
                if( updateResult.error )
                    return updateResult.error
            }

            // update wallet balances - if txUpdate true it will do wallet tx at same time as onChain
            this.walletTransactionData({ ...transaction, blockIdx, txUpdate })
            
            // now if we got the error with pending posted on multiple servers, lets' have that warning appear here
            if( warning ){
                TransactionHandler.updateMeta([transaction],'warning',warning)
                debug('green',`     \\ ! attached warning: "${warning}"` )
            }

        } else if( blockIdx > -1 ){
            // not new, so likely was a mempool, now converted to a block entry
            transaction = { error: `Existing: [${src.split(':')[0]}/${seq} -> ${dest.split(':')[0]} $${amount}] but updated wallet.onChain & hashes-lookup: block = #${blockIdx}${data.seq > 0 ? `; onChain(${data.seq})` : '' }`, updateSeq: true, index: blockIdx }
            
            // update user wallet to reflect it's onChain (add value + update seq)
            // ***************** TODO re-think
            // transaction hash already exists, so mempool tx updated; we just want to update the onChain values...
            if( !testOnly ){
                Mempool.updateHashBlockIdx(hash,blockIdx)
                const result = this.walletTransactionData({ src, dest, amount, fee, seq, blockIdx, txUpdate: true })
                console.log( `walletTransactionData`, Wallet.addresses)
                if( result.error ) return result
            }
        } else {
            debug( 'red', ` .. new(hash=${hash}) mempool transaction tried, but already in #${this.hashes[hash].index}; ignoring.`)
            transaction = { error: `Should NOT come here: hash(${hash} blockIdx(${blockIdx})`, index: this.hashes[hash].index }
        }

        return transaction
    }

    static newBatch( _transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false }= options

        // run ledger transaction & add to hash list
        let newHashes = [], deleteHashes = [], hashes = [], result = [], error = '', transactionCnt = 0

        if( blockIdx>-1 ) debug('cyan',`\n- [block#${blockIdx}]: (transactions: ${_transactions.length}) ------------------------------------------------------------------------` )
        for( const _transaction of _transactions ){
            const transaction = this.new(_transaction, { blockIdx, txUpdate })
            hashes.push( _transaction.hash || transaction.hash )
            result.push( transaction ) // includ transaction.error results
            if( transaction.error ){
                if( transaction?.index<0 ){
                    // failed so delete hash-look-up reference to this transaction hash
                    debug( 'dim', `   .. ${transaction.error} (Failed transaction; deleting hash)`)
                    deleteHashes.push( _transaction.hash )
                    // delete this.hashes[_transaction.hash]
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
        
        return { error: error || false, result, transactionCnt, hashes, newHashes, deleteHashes }
    }

    // when we fail to mine a block, since we'll be retrying, don't reverse any ledger balances (yet)
    static updateHashBlockIdx( transactions ){
        let pending = 0, undo = 0
        for( const transaction of transactions ){
            if( transaction.hash && Mempool.exists(transaction.hash) ){
                // user transactions we'll retry - so don't reverse ledger
                debug('dim',`    ~ ${transaction.src.split(':')[0]}/${transaction.seq} >> ${transaction.dest.split(':')[0]} $${transaction.amount} [${transaction.type}] -> reverted to mempool.`)
                Mempool.clearBlockIndex(transaction.hash)
                pending++
            }
        }
        return { error: false, pending }
    }

    static updateMeta(transactions,field,value){
        for( const t of transactions ){
            if( !t.meta ) t.meta = {}

            if( !t.meta[field] ){
                t.meta[field] = value
                if( field === 'miner' ) t.meta.minerStart = time()
            }
        }
    }

    static reverse({src, dest, amount, fee, seq, hash, ...data}){
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}
        // is it already in hash tracker?
        // const hashData = this.hashes[hash]

        const index = Mempool.findBlockIndex(hash)

        // if wasn't found at all, nothing to reverse
        if( index === false ){
            debug('dim',`    ~ x no hash index entry found, so nothing more to do.`)
            // this.pending = this.pending.filter( t => t.hash !== hash )
            return { error: false, index: '' }
        }

        if( index === -1 ){
            debug('dim', `    ~ ${src.split(':')[0]}/${seq} >> ${dest.split(':')[0]} $${amount} -> removing mempool entry + removed hash.`)
            Mempool.deleteQueue([hash])
        }
        
        const transactionData = {src, dest, amount, fee, seq, hash, ...data}
        const options = { blockIdx: index, txUpdate: true, reverse: true }
        const transaction = this.buildTransaction(transactionData, options)
        if( transaction.error ) return transaction

        // reverse wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        this.walletTransactionData({ ...transaction, ...options })

        return transaction
    }

    static reverseBatch( transactions ){
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
    
}
