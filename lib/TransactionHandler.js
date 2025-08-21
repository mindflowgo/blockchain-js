/******************************************
 * Mining Transaction Class
 * 
 * (c) 2025 Filipe Laborde / fil@rezox.com
 * v1.2
 * - added token detection in amounts for ease of use, ex. sol$100 -> token = _sol$, amount = 100
 * 
 * MIT License
 * 
 * This class provides transaction management within the miner
 * 
 * Unconfirmed/pending transactions are dealt with in the node as they are relevant to it's
 * operations in deciding blocks to mine, and what info to communicate to other nodes.
 */

import Crypto from './Crypto.js'

import { fixRounding, time, waitReady, debug } from './helper.js'


const MINT_TOKEN = '*$'                 // do not change this!
const BASE_TOKEN = '$'                  // any token *MUST* end with $ as this is system identifier for tokens

// min/max # of user/admin -- ie non-system generated tarnsactions (reward, fees, etc)
const BLOCK_MIN_TRANSACTIONS = 1
const BLOCK_MAX_TRANSACTIONS = 10
const BLOCK_TRANSACTION_TYPES_USER = ['minerDeposit','transfer','purchase'] // valid user transaction types
const BLOCK_TRANSACTION_TYPES_ADMIN = ['tokenCreate','tokenAdjust','tokenAirdrop'] // create only for new, adjust requires auth signing by creator
const BLOCK_TRANSACTION_TYPES_SYSTEM = ['miningReward', 'miningFees','tax']
const VALID_TRANSACTION_TYPES = [...BLOCK_TRANSACTION_TYPES_USER, ...BLOCK_TRANSACTION_TYPES_ADMIN, ...BLOCK_TRANSACTION_TYPES_SYSTEM]

const TRANSACTION_FEE_PERCENT = 1           // commission 1%
const TRANSACTION_FEE_CAP = 100             // most to charge ($)

// Miner Class =================================================================================
export default class TransactionHandler {
    constructor(nodeName, Mempool, Wallet) {
        this.MINT_TOKEN = MINT_TOKEN
        this.BASE_TOKEN = BASE_TOKEN
        this.BLOCK_MIN_TRANSACTIONS = BLOCK_MIN_TRANSACTIONS
        this.BLOCK_MAX_TRANSACTIONS = BLOCK_MAX_TRANSACTIONS
        this.nodeName = nodeName

        // classes used
        this.Mempool = Mempool
        this.Wallet = Wallet
        debug( 'green', `transactionHandler: transaction fee: ${TRANSACTION_FEE_PERCENT}% ${TRANSACTION_FEE_CAP > 0 ? `, fee cap (${TRANSACTION_FEE_CAP})` : ''}`)
    }

    setHelperClasses(Wallet,Mempool){
        this.Wallet = Wallet
        this.Mempool = Mempool
    }

    // user ending with '$' are admin/system users, '*$' is prefix for ecosystem token type
    // which we first send to the _mint of that token which then uses them
    createToken(supply, token = this.BASE_TOKEN, admin = this.nodeName){
        // the issuer of the genesis transaction is arbiter of distributions (airdrops), ie they need to sign-off on any
        debug(`[createToken] nodeName(${this.nodeName}) )`)
        const transactionData = { src: this.MINT_TOKEN, dest: token, amount: supply, token, type: 'tokenCreate', timestamp: 0 }
        if( token !== this.BASE_TOKEN ){
            // building token issue only for new issue tokens - cannot usurp a token already issued
            const tokenWallet = this.Wallet.getUser(token, false)
            if( !tokenWallet.error ) return { error: `Token already created, can't prepare genesis token issue (${token}).` }
            // if an alt token, enable airdrop Auth code
            transactionData.timestamp = time()
            transactionData.tokenAdmin = this.Wallet.buildNameWithPublicKey(admin)
        } else {
            // auto-create token account if needed
            const tokenWallet = this.Wallet.getUser(token)
            if( tokenWallet.error ) return tokenWallet
        }

        const genesisTransaction = this.getSeqAndSign(transactionData)
        if( genesisTransaction.error ) return genesisTransaction
        // returning genesis gransactions initialized
        return [ genesisTransaction ]
    }

    extractTokenFromAmount( amount, token ){
        if( typeof(amount) === 'string' && amount.includes('$') ){
            ([token, amount] = amount.split('$'))
            token += '$'
        } else {
            // token = token && token.includes('$') ? token : this.BASE_TOKEN
            token = token || this.BASE_TOKEN
        }
        amount = Number(amount || 0)
        return [ amount, token ]
    }

    getFee({ amount, token = '', fee=0 }){
        // in BTC network: users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)
        fee = Number( Math.max( 0, fee ) )

        // we will allow token to be passed in the amount oo, ex. sol$100 or else amount=100, token = '_sol$'
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        if( token == this.BASE_TOKEN ) {
            fee = fixRounding( Math.max(fee, Number(amount || 0) * TRANSACTION_FEE_PERCENT/100) )
            if( TRANSACTION_FEE_CAP > 0 )
                fee = Math.min(TRANSACTION_FEE_CAP, fee)
        } else {
            // fixed fee for other tokens 
            fee = 0.05
        }
        return fee
    }

    calcHash(transaction) {
        // clone transaction before removing fields, otherwise pass-by-reference problems!
        const hashableTransaction = { ...transaction }

        // we include ALL transaction fields in hash, except:
        // - non-transaction mining metadata excluded (meta)
        // - signature that is DONE on this hash, thus depends on it
        // - hash itself
        delete hashableTransaction.meta
        delete hashableTransaction.txSig
        delete hashableTransaction.hash
        // Ethereum and some other blockchains use Keccak-256 as it has better protection against quantum computing
        // But sha256 is strong, and used by BTC and similar ecosystems - we use it
        return Crypto.hash(hashableTransaction)
    }

    // Find unique src/dest user list in the transactions provided
    findUsers( transactions ){
        const users = {}
        for( const t of transactions ){
            users[t.src] = 1; users[t.dest] = 1
        }
        return Object.keys(users)
    }

    checkTransactionCount(transactions) {
        let transactionCnt = 0
        // calc how many user transactions in block, we have blockchain limits (to prevent niners from skimping to get more credit, etc)
        for( const t of transactions )
            if( VALID_TRANSACTION_TYPES.includes(t.type) )
                transactionCnt++

        if( transactionCnt >= BLOCK_MIN_TRANSACTIONS && transactionCnt <= BLOCK_MAX_TRANSACTIONS ) 
            return transactionCnt
        else
            return { error: `Need min:${BLOCK_MIN_TRANSACTIONS}/max:${BLOCK_MAX_TRANSACTIONS} user transactions per block, found: ${transactionCnt || '-'}. Rejecting.` }
    }    

    transactionTypeOperations({ src, dest, type, amount, token, ...data }) {
        if( type === 'tokenCreate' ) {
            const destWallet = this.Wallet.getUser(dest, false)
            if( destWallet.error ){
                debug('red',`Some REALLY wrong happened. Token issue transaction exists without a matching WALLET for the token (${dest}), type(${type})`)
                return destWallet
            }
            debug('cyan',`  > ~ [admin-transaction] found token issue (${dest}) for ${amount} tokens. tokenAdmin: ${data.tokenAdmin}`)
            if( data.tokenAdmin ) this.Wallet.update(dest, { tokenAdmin: data.tokenAdmin })
        }
        return { error: false }
    }

    // check transactions are all signed, and seq ok
    auditTransactions(blockMiner, blockIdx, transactions, expectedMiningReward) {
        console.log( `[auditTransactions] blockIdx(${blockIdx}) transactions[${transactions.length}]`)
        let miningReward = 0, miningFees = 0, transactionCnt = 0, adminCnt = 0, transactionError = false

        // genesis block we just accept
        if( blockIdx === 0 ) return { error: false, transactionCnt: 0, adminCnt: transactions.length, miningFees: 0 }

        const validTransactionCnt = this.checkTransactionCount(transactions)
        if( validTransactionCnt.error ) return validTransactionCnt

        // gather all wallets as we're doing a dry run through transactions
        // then snapshot them as we'll be changing the values in them simulating adding
        // all these transactions, making sure we don't run into negative values, etc.
        const transactionUsers = this.findUsers(transactions)
        debug('dim', `[auditTransactions] snapshotting users (${transactionUsers.join(',')}) ==============`)
        this.Wallet.userSnapshots( transactionUsers )
        this.Wallet.debugOutputLevel = 0 // don's show output while usingit

        for( const transaction of transactions ){

            // check transaction itself (signing, balances) by doing it
            const transactionResult = this.processTransaction(transaction, { blockIdx, manageMempool: false } );
            if( transactionResult.error ) transactionError = transactionResult.error

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
                const matchingTransaction = transactions.filter( t => t.hash === transaction.source )
                if( transaction.dest.startsWith(blockMiner+':') && matchingTransaction.length === 1 &&
                    matchingTransaction[0].txSig.length > 10 && matchingTransaction[0].fee == transaction.amount )
                    miningFees += transaction.amount
                else
                    transactionError = `Block miningFees illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}) for amount(${transaction.amount}). Rejecting.`

            } else if( transaction.type === 'tokenCreate' ){
                adminCnt++
                // mint issue normally only genesis block; unless increasing supply
                // TODO do we allow outside genesis? && index === 0 ?
                debug('cyan',`  ~ Note: admin-level tokenCreate for ${transaction.token} transaction detected` )
            } else if( transaction.type === 'tokenAirdrop' ){
                adminCnt++
                // check against tokenAdmin!
                // should probe back to core system if sanctioned, and what server
                debug('cyan',`  ~ Note: admin-level tokenAirDrop transaction detected: ${transaction.amount} >> ${transaction.dest}` )
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
        this.Wallet.userRestores( transactionUsers )
        this.Wallet.debugOutputLevel = 1
        debug('dim',`-- wallet restore --//`)
        // an object with transaction error will be returned, else simply false
        if( transactionError ) 
            return transactionError
        else
            return { error: false, transactionCnt, adminCnt, miningFees }

    }

    // when chains confliect, we keep our transactions to attempt rechaining later (dropping system ones)
    filter({ transactions, hashes = [], types = [] }) {
        // organize list of transaction types we want to filter by
        let typeList = []
        if( typeof(types) === 'string' ) types = types.split(',').filter(s => s != '')
        if( types.includes('user') ) typeList.concat( BLOCK_TRANSACTION_TYPES_USER )
        if( types.includes('admin') ) typeList.concat( BLOCK_TRANSACTION_TYPES_ADMIN )
        if( types.includes('system') ) typeList.concat( BLOCK_TRANSACTION_TYPES_ADMIN )
        if( types.includes('tokenCreate') ) typeList = 'tokenCreate'

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
    transactionSign({src, dest, amount, token, fee = 0, type = '', seq = 0, txSig = '', hash = '', meta, ...data}){
        // build transaction        
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        amount = fixRounding( amount )
        fee = fixRounding( Number(fee || 0) )

        // EXCLUDES [ txSig, hash, meta ] fields from transaction for hash calculation & signing
        const newTransaction = { timestamp: time(), src, dest, amount, token, fee, type, seq, ...data } 
        // we are signing as of NOW, hence timestamp updated, and then generate fresh hash (that we sign to prove we accepted this)
        const newHash = this.calcHash(newTransaction)
        if( hash !== '' && hash !== newHash ){
            if( this.debugOutputLevel ) debug('red',` [transactionSign] Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.`, newTransaction )
            return { error: `Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.` }
        }

        // transaction signing possible for:
        //   a) signing-exempt admin-level account on node (ends with $)
        //   b) supplied external valid txSig
        //   c) src wallet with _privateKey_ available
        if( src.endsWith('$')) { //a)
            // admin-level src, signing-exempt

        } else if( txSig ){ // b)
            // verify the sig given is valid
            const decodedHash = this.Wallet.decode(src, txSig)
            if( decodedHash !== newHash ){
                if( this.debugOutputLevel ) debug('red',` xx Signature was INVALID, rejecting transaction.`)
                return { error: `[transactionSign] Transaction signature was INVALID, rejecting.` }
            }

        } else { // c)
            // wasn't signed, BUT we have the private key, so we assume it's from a sanctioned system, we'll sign it
            txSig = this.Wallet.sign(src, newHash) 
        }

        if( txSig ) newTransaction.txSig = txSig
        if( meta ) newTransaction.meta = meta
        newTransaction.hash = newHash

        return newTransaction
    }

    // builds transaction (mostly in the transactionSign() method), checks seq is ok
    getSeqAndSign({src, dest, amount, token, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}, options = {}){
        const { blockIdx = -1, txUpdate = false, reverse = false }= options

        let newTransaction

        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        if( reverse ){
            amount = -amount
            fee = -fee
        }

        src = this.Wallet.buildNameWithPublicKey(src)
        if( src.error ) return src
        dest = this.Wallet.buildNameWithPublicKey(dest)
        if( dest.error ) return dest

        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        
        // type must be valid
        if( !VALID_TRANSACTION_TYPES.includes(type) ){
            return { error: `Unknown transaction type(${type}); hash(${hash}): choices(tokenAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( reverse ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            newTransaction = { timestamp: time(), src, dest, amount, token, fee, type: `reversal:${type}`, hash: '', source: hash,  ...data }

        } else {
            // determine SEQ ----------
            const srcWallet = this.Wallet.getUser(src)
            console.log( ` [getSeqAndSign] srcWallet.seq.tx(${srcWallet.seq.tx}) seq(${seq})`)
            if( src.endsWith('$') )
                seq = 0 // admin-level don't need signing, and will be attributed for in parallel on many nodes, leave seq = 0
            else if( seq < 1 ) 
                seq = srcWallet.seq.tx + 1 // auto-gen it as it doesn't need signed trans with seq (ex admins)
            else {
                // we need a seq that is valid and +1 on tx or onChain (depending on if trans is being done for writing block or just mempool)
                // SIGNING REQUIRED (seq NEEDED!) -- TODO should queue it up and look later (ex. if out of order), for onChain know that trans related to a block?
                // debug( 'green', `[ledger::transaction] (${srcWallet.name}/${seq}) blockIdx(${blockIdx}) trans-seq(${seq}) tx.seq(${srcWallet.seq.tx}) onChain.seq(${srcWallet.seq.onChain}) `)
                if( blockIdx === -1 && seq !== (srcWallet.seq.tx + 1) )
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount} rejected - need seq = srcWallet.seq.tx+1(${srcWallet.seq.tx+1})...`, 
                            blockIdx, seq: srcWallet.seq.tx, balance: Number(srcWallet[token].tx.balance) }
                else if( blockIdx > -1 && seq !== (srcWallet.seq.onChain + 1) )
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount}] rejected - block#${blockIdx}; need seq = onChain.seq+1(${srcWallet.seq.onChain+1})..`, 
                            blockIdx, seq: srcWallet.seq.onChain, balance: Number(srcWallet[token].onChain.balance) }
            } 
                 
            // SIGN IT (attempt at least) using seq determined above
            console.log( `[getSeqAndSign] transaction ${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest}  ${token}${amount}`)
            newTransaction = this.transactionSign({src, dest, amount, token, fee, type, seq, txSig, hash, ...data})

            if( newTransaction.error ) return newTransaction
        }
        return newTransaction
    }

    checkTokenBalances({src, dest, amount, token = '', fee = 0, type = '', seq = 0, txSig = '', hash = '', meta, ...data}, options = {}){
        const { blockIdx = -1 }= options


        const srcWallet = this.Wallet.getUser(src)
        console.log( `[checkTokenBalances] src(${src}) getUser:`, srcWallet)
        { [amount, token] = this.extractTokenFromAmount(amount, token) }
        
        if( src === this.MINT_TOKEN ) {
            debug('dim',`    ~ System Token Issue Transaction for: [${token}]${amount}`)

        } else if( blockIdx === -1 ){ // memory-only so far
            if( token === this.BASE_TOKEN && Number(srcWallet[token].tx.balance) < (amount+fee) ){
                return { error: `${this.Wallet.getNameOnly(src)} balance(${srcWallet[token].tx.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet[token].tx.balance) }
            } else if( token !== this.BASE_TOKEN && (Number(srcWallet[token].tx.balance) < amount || Number(srcWallet[this.BASE_TOKEN].tx.balance) < fee)) {
                return { error: `${this.Wallet.getNameOnly(src)} balance(${srcWallet[token].tx.balance}) less than transaction amount(${amount} or fee=${fee} more than fee-account(${srcWallet[this.BASE_TOKEN].tx.balance}). Rejecting.`, balance: Number(srcWallet[token].tx.balance) }
            }
        } else if( blockIdx > -1 ){
            if( token === this.BASE_TOKEN && Number(srcWallet[token].onChain.balance) < (amount+fee) ){
                return { error: `${this.Wallet.getNameOnly(src)} onChain balance(${srcWallet[token].onChain.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet[token].onChain.balance) }
            } else if( token !== this.BASE_TOKEN && (Number(srcWallet[token].onChain.balance) < amount || Number(srcWallet[this.BASE_TOKEN].onChain.balance) < fee)) {
                return { error: `${this.Wallet.getNameOnly(src)} balance(${srcWallet[token].onChain.balance}) less than transaction amount(${amount} or fee=${fee} more than fee-account(${srcWallet[this.BASE_TOKEN].onChain.balance}). Rejecting.`, balance: Number(srcWallet[token].onChain.balance) }
            }
        }

        // update balance for meta data passed back (non-commital value), but not used for internal calculations
        // const balance = fixRounding((blockIdx === -1 ? srcWallet[token].tx.balance : srcWallet[token].onChain.balance) - (amount+fee))
        // this.updateMeta( [newTransaction], 'balance', balance)
        if( this.debugOutputLevel ){
            debug('cyan',`  ~ #${blockIdx}:transaction${reverse?' *REVERSED*':''} [${this.Wallet.getNameOnly(src)}${seq>0 ?'/'+seq:''}${srcWallet.privateKey?'[Signed]':''}`
                        +` -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount}] / ${newTransaction.type || ''} `+( fee ? `fee(${fee}) `  : '') + (txUpdate ? '[txUpdate]' : '' ) 
                        + (seq>0 || srcWallet.seq.tx>0 || srcWallet.seq.onChain>0 ? ` seq(${seq}) seq.tx(${srcWallet.seq.tx}) seq.onChain(${srcWallet.seq.onChain})` : '') )
            //filter( item=>[src,dest].includes(item.name) ).
            console.log( "$$$$$ - $$$$$")
            this.Wallet.balances([src,dest])
        }

        return { error: false }
    }

    walletTxBalanceUpdate({ wallet, amount, token, seq, reverse = false }) {
        wallet[token].tx.amount = amount
        wallet[token].tx.balance = fixRounding( wallet[token].tx.balance + amount )
        if( seq ) wallet.seq.tx = !reverse ? Math.max(seq, wallet.seq.tx, wallet.seq.onChain) : wallet.seq.onChain
        debug('dim',`     ~ [walletTxBalanceUpdate] tx.balance + (${amount}) seq(${wallet.seq.tx || 'n/a'})`)
    }

    walletOnChainBalanceUpdate({ wallet, amount, token, seq, reverse = false, blockIdx }) {
        const tokenOnChain = wallet[token].onChain
        tokenOnChain.amount = amount
        tokenOnChain.balance = fixRounding( tokenOnChain.balance + amount )
        if( seq ) wallet.seq.onChain = !reverse ? seq : Math.max( seq-1, 0 )
        if( !reverse ){
            if( !tokenOnChain.historyIdx.includes(blockIdx) ) tokenOnChain.historyIdx.unshift(blockIdx) // prepend block
        } else {
            // BUGBUG REVIEW LOGIC: assumes all transactions in that block will be reversed, so removes block
            if( tokenOnChain.historyIdx.includes(blockIdx) ) tokenOnChain.historyIdx.shift() 
        }
        tokenOnChain.historyIdx = tokenOnChain.historyIdx.slice(0,10) || []
        debug('dim',`     ~ [walletOnChainBalanceUpdate] onChain.balance + (${amount}) seq(${wallet.seq.onChain || 'n/a'})`)
    }

    walletTransaction({ name, amount, token, seq, hash }, options = {}){
        const { blockIdx = -1, txUpdate = false, reverse = false }= options

        const wallet = this.Wallet.getUser(name)

        // if this token not in system, create it
        if( !wallet[token] ) this.Wallet.initToken( wallet, token )

        // if blockIdx -1: transaction mempool only; else onChain, and if it wasn't mempool'd first, we update mempool tally (txUpdate:true)
        if( blockIdx > -1 ) // block provided, so wallet onChain settings updated
            this.walletOnChainBalanceUpdate({ wallet, amount, token, seq, reverse, blockIdx })
        
        if( blockIdx === -1 || txUpdate ) // mempool transaction, OR txUpdate flag set
            this.walletTxBalanceUpdate({ wallet, amount, token, seq, reverse })

        debug('dim',`     ~ [walletTransaction] ${this.Wallet.getNameOnly(name)} ${token}${amount} blockIdx(${blockIdx}) txUpdate(${txUpdate}) tx.balance(${wallet[token].tx.balance}) onChain.balance(${wallet[token].onChain.balance})`)
        
        // let's write it!
        const result = this.Wallet.update( name )
        // console.log( ` ...[walletTransactionData](${walletAddress}) token=(${token})Update:`, JSON.stringify({ onChain, tx }))
        // debug(this.debugOutputLevel ? 'green' : 'dim', `        ${walletAddress.split(':')[0]} +tx(${wallet.tx.amount})=(${wallet.tx.balance}) +chain(${wallet.onChain.amount})=(${wallet.onChain.balance})`)
        if( result.error ) return result
        return { error: false }
    }

    // update the wallet values
    // if a block#, does onChain; if no block# does tx; if block# + txUpdate, does BOTH
    walletTransactionData({ src, dest, amount, token, fee, seq, blockIdx = -1, txUpdate = false, reverse = false }) {
        // extract token from amount if present, ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        if( !src || !dest || amount == 0 )
            return { error: `Missing parameter (src: ${src}, dest: ${dest}, amount: ${amount}` }
        debug('dim',`     ~ [walletTransactionData] ${src} --------------------------------------` ) 
        amount = fixRounding( amount )
        fee = fixRounding( Number(fee || 0) )

        let result
        // _src_ user: deduct amount
        result = this.walletTransaction({ name: src, token, amount: -amount, seq}, { blockIdx, txUpdate, reverse })
        if( result.error ) return result
        // _dest_ user: add amount
        result = this.walletTransaction({ name: dest, token, amount }, { blockIdx, txUpdate, reverse })
        if( result.error ) return result

        // deduct fee
        if( Number(fee)>0 ){
            // _src_ user: deduct fee
            result = this.walletTransaction({ name: src, token: this.BASE_TOKEN, amount: -fee }, { blockIdx, txUpdate, reverse })
            if( result.error ) return result
            // _token_ pool: return fee -> token pool will pay out to the miner upon block mint
            result = this.walletTransaction({ name: this.BASE_TOKEN, token: this.BASE_TOKEN, amount: fee }, { blockIdx, txUpdate, reverse })
            if( result.error ) return result
        }
    }

    rewardTransaction(transaction, blockIdx) {
        // extract token from amount if present, ex. sol$100
        transaction = this.getSeqAndSign(transaction,{ blockIdx })
        const balanceCheck = this.checkTokenBalances(transaction,{ blockIdx })
        if( balanceCheck.error ) return balanceCheck

        return transaction
    }

    // prepare a transaction for miner (so adjust pending layer too)
    // getSeqAndSign + Memool.addQueue + walletTransaction
    processTransaction({src, dest, amount, token = '', fee = 0, seq = 0, txSig = '', hash = '', ...data}, options = {} ) {
        const { blockIdx = -1, txUpdate = false, manageMempool = true }= options

        // Validate transaction
        if (!src || !dest || !amount) {
            debug('red',`Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            return { error: `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` }
        }

        // extract token from amount if present, ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        let transaction = {src, dest, amount, token, fee, seq, txSig, hash, ...data}

        // there are only 2 states:
        // - in mempool: already processed, so just update onchain amount
        // - new: do full processing
        const alreadyExists = hash && this.Mempool.exists(hash) ? true : false
        debug('dim', `          ![processTransaction] [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(dest)} [${token}]${amount}] hash(${hash}) alreadyExists(${alreadyExists})`)
        if( alreadyExists && blockIdx > -1 ) {
            debug('dim', `           -- existing hash(${hash}) blockIdx(${blockIdx}) + onChain wallet`)
            if( manageMempool ) this.Mempool.updateHashBlockIdx(hash,blockIdx)
            const result = this.walletTransactionData({ ...transaction, blockIdx, txUpdate: false })
            if( result?.error ) return result
            return transaction

        } else if( alreadyExists ) {
            return { error: `Existing: [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(dest)} [${token}]${amount}], duplicate/old tx entry. Ignoring.`, updateSeq: true, index: blockIdx }            
        }

        // NEW TRANSACTION - process fully
        debug('dim', `           -- new blockIdx(${blockIdx}) > sign >addQueue | update > tx + onChain wallet`)

        let warning = data.meta?.warning || '' // pre-set warning with any prior meta-data from it
        // token/admin accounts ($) no fees, others pay fees
        fee = src.endsWith('$') ? 0 : this.getFee({ amount, token, fee })

        transaction = this.getSeqAndSign(transaction,{ blockIdx, txUpdate })
        const balanceCheck = this.checkTokenBalances(transaction,{ blockIdx })
        if( transaction.error ) {
            transaction.index = blockIdx
            return transaction

        } else if( balanceCheck.error ) {
            transaction.index = blockIdx
            return balanceCheck
        }

        // any type-specific operations
        const typeResult = this.transactionTypeOperations(transaction)
        if( typeResult.error ) return typeResult

        // MEMPOOL
        if( blockIdx === -1 ){
            // no mempool entry, and we're just queuing it
            // if( !transaction.meta ) transaction.meta = {}
            if( manageMempool ) {
                const addCnt = this.Mempool.addQueue( [transaction] )
                if( addCnt?.error ) return addCnt
            }

            let warning = ''
            for( const t of this.Mempool.filter('src',transaction.src) )
                if( t.meta?.miner && t.meta.miner !== this.nodeName ) warning += `queued also on ${t.meta.miner}; `
            if( warning ) this.updateMeta( [transaction],'warning',warning )

            // indicate queue time
            this.updateMeta( [transaction],'queueTime',time() )

        } else {
            if( manageMempool ) {
                const updateResult = this.Mempool.updateHashBlockIdx(transaction.hash,blockIdx)
                if( updateResult.error ) return updateResult
            }
        }

        // update wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        const result = this.walletTransactionData({ ...transaction, blockIdx, txUpdate: true })
        // console.log( `[processTransaction] Wallet Addreses (after)`, JSON.stringify(this.Wallet.addresses))
        if( result?.error ) return result

        // now if we got the error with pending posted on multiple servers, lets' have that warning appear here
        if( warning ){
            this.updateMeta([transaction],'warning',warning)
            debug('green',`     \\ ! attached warning: "${warning}"` )
        }

        return transaction
    }

    processTransactions( _transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false }= options

        // run ledger transaction & add to hash list
        let newHashes = [], deleteHashes = [], hashes = [], result = [], error = '', transactionCnt = 0

        if( blockIdx>-1 ) debug('cyan',`\n- [block#${blockIdx}]: (transactions: ${_transactions.length}) ------------------------------------------------------------------------` )
        for( const _transaction of _transactions ){
            const transaction = this.processTransaction(_transaction, { blockIdx, txUpdate })
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


    syncTxToChain( addresses, minerTokens = false ){
        // addresses { name1: [ USDC, USDB ] }
        if( minerTokens ){ 
            // gather token accounts for this miner
            addresses = { [this.nodeName]: this.Wallet.findUsers('$') }
            debug( 'cyan', `[TransactionHandler::syncTxToChain] miner-token sync tx >> onChain`, addresses )
        } else {
            debug('dim',`[TransactionHandler::syncTxToChain] for addresses:`, addresses)
        }

        // if there are no pending for a tx, it MUST be same as onChain, else we sync
        // this may be due to BUGBUG bugs in the system, as this shouldn't happen but it does
        // with complex intermeshed queries
        for( const user of Object.keys(addresses) ){
            for( const token of addresses[user] ) {
                // we can ONLY try to balance token baseToken (ex. $) when there are NO pending in progress
                if( user.indexOf('$')>-1 && !minerTokens ) continue

                // no pending, are balances different? if so we sync them!
                const wallet = this.Wallet.getUser(user)
                
                if( wallet[token].tx.balance !== wallet[token].onChain.balance ){
                    debug( 'cyan', `   ~ [revertTxToChain] ${wallet.name} ${token} no pending but chain diff: tx.balance(${wallet[token].tx.balance}) onChain.balance(${wallet[token].onChain.balance}), sync to onChain value.`)
                    wallet[token].tx.amount = wallet[token].onChain.amount
                    wallet[token].tx.balance = wallet[token].onChain.balance
                    wallet.tx.seq = wallet.onChain.seq // Math.max(wallet.tx.seq, wallet.onChain.seq) // Don't move tx.seq backwards
                }
            }
        }
    }
    
    // when we fail to mine a block, since we'll be retrying, don't reverse any ledger balances (yet)
    clearBlockMempool( transactions ){
        let pending = 0, undo = 0
        for( const transaction of transactions ){
            if( transaction.hash && this.Mempool.exists(transaction.hash) ){
                // user transactions we'll retry - so don't reverse ledger
                debug('dim',`    ~ ${this.Wallet.getNameOnly(transaction.src)}/${transaction.seq} >> ${this.Wallet.getNameOnly(transaction.dest)} [${transaction.token}]${transaction.amount} [${transaction.type}] -> reverted to mempool.`)
                this.Mempool.clearHashBlockIdx(transaction.hash)
                pending++
            }
        }
        return { error: false, pending }
    }

    updateMeta(transactions,field,value){
        for( const t of transactions ){
            if( !t.meta ) t.meta = {}

            if( !t.meta[field] ){
                t.meta[field] = value
                if( field === 'miner' ) t.meta.minerStart = time()
            }
        }
    }

    removeMeta(transactions){
        return transactions.map( ({meta, ...data})=> data )
    }

    reverse({src, dest, amount, token, fee, seq, hash, ...data}){
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}
        // is it already in hash tracker?
        // const hashData = this.hashes[hash]

        // extract token from amount (if present), ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        const index = this.Mempool.findHashBlockIndex(hash)

        // if wasn't found at all, nothing to reverse
        if( index === false ){
            debug('dim',`    ~ x no hash index entry found, so nothing more to do.`)
            // this.pending = this.pending.filter( t => t.hash !== hash )
            return { error: false, index: '' }
        }

        if( index === -1 ){
            debug('dim', `    ~ ${this.Wallet.getNameOnly(src)}/${seq} >> ${this.Wallet.getNameOnly(dest)} $${amount} -> removing mempool entry + removed hash.`)
            this.Mempool.deleteQueue([hash])
        }
        
        const transactionData = {src, dest, amount, token, fee, seq, hash, ...data}
        const options = { blockIdx: index, txUpdate: true, reverse: true }
        const transaction = this.getSeqAndSign(transactionData, options)
        if( transaction.error ) return transaction
        const balanceCheck = this.checkTokenBalances(transaction,{ blockIdx })
        if( balanceCheck.error ) return balanceCheck

        // reverse wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        this.walletTransactionData({ ...transaction, ...options })

        return transaction
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
    
}
