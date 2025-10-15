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

import { fixRounding, time, waitReady, debug, errorWithData } from './helper.js'

// your fee structure
const FEE_BASE_TRANSACTION = process.env.FEE_BASE_TRANSACTION   // >0 = fixed fee; <0 = percent (ex. -10 = 10%)
const FEE_TOKEN_CREATE = process.env.FEE_TOKEN_CREATE           // token creation fee
const FEE_TOKEN_TRANSACTION = process.env.FEE_TOKEN_TRANSACTION // transaction costs
const FEE_TOKEN_AIRDROP = process.env.FEE_TOKEN_AIRDROP
const FEE_MAX = process.env.FEE_MAX                             // max to charge for fees ($)

// do not change these - if running node to join active network
const BLOCKCHAIN_PUBLICKEY = process.env.BLOCKCHAIN_PUBLICKEY
const BLOCKCHAIN_TXAUTH = process.env.BLOCKCHAIN_TXAUTH
const MINT_TOKEN = process.env.MINT_TOKEN
const BASE_TOKEN = process.env.BASE_TOKEN                 // any token *MUST* end with $ as this is system identifier for tokens

// min/max # of user/admin -- ie non-system generated tarnsactions (reward, fees, etc)
const BLOCK_MIN_TRANSACTIONS = process.env.BLOCK_MIN_TRANSACTIONS
const BLOCK_MAX_TRANSACTIONS = process.env.BLOCK_MAX_TRANSACTIONS
 

const TRANSACTION_TYPES_USER = ['minerDeposit','transfer','purchase','tax'] // valid user transaction types
const TRANSACTION_TYPES_ADMIN = ['tokenCreate','tokenAirdrop'] // create only for new, adjust requires auth signing by creator
const TRANSACTION_TYPES_SYSTEM = ['miningReward', 'miningFees']
const VALID_TRANSACTION_TYPES = [...TRANSACTION_TYPES_USER, ...TRANSACTION_TYPES_ADMIN, ...TRANSACTION_TYPES_SYSTEM]

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
    }

    setHelperClasses(Wallet,Mempool){
        this.Wallet = Wallet
        this.Mempool = Mempool
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

    // user ending with '$' are admin/system users, '*$' is prefix for ecosystem token type
    // which we first send to the _mint of that token which then uses them
    tokenCreation(amount, token = this.BASE_TOKEN, admin){
        // the issuer of the genesis transaction is arbiter of distributions (airdrops), ie they need to sign-off on any
        const type = 'tokenCreate'
        const fee = this.getFee({ amount, token, type })
        let transactionData = { 
            src: this.MINT_TOKEN, dest: token, amount, token, fee, 
            type, timestamp: 0, seq: 0, admin: null, txAuth: null, hash: null }

        // creating TOKEN ACCOUNT (it's simply another wallet-account - but can only create 1 time)
        debug( 4, `<cyan>[tokenCreation] amount(${amount}) token(${token}) admin(${admin}) fee(${fee}). Creating token bearer-user.</>`)
        const wallet = this.Wallet.getUserOrCreate(token)
        if( wallet.created < (time()-1) ){
            debug( ` .... ops this token-user <i>ALREADY</i> created ${time()-wallet.created}s ago.), <b>rejecting</>`)
            throw errorWithData(`Token already created, can't prepare genesis token issue (${token}).`, { token, wallet })
        }
        // now setup the token for this wallet & save
        this.Wallet.initToken( wallet, token )
        this.Wallet.update(token)

        if( token === this.BASE_TOKEN ){
            // add the admin as we need this for initial signing
            // hardcoded public-key for BASE_TOKEN issue; coded this way for simplicity. must be consistent across all node installs.
            const admin = '*root:' + BLOCKCHAIN_PUBLICKEY
            this.Wallet.update(token, { admin })

            // if we are creating the BASE_TOKEN, it's initial setup, so create MINT_TOKEN too
            const mintWallet = this.Wallet.getUserOrCreate(this.MINT_TOKEN)
            this.Wallet.update(this.MINT_TOKEN)

            transactionData.seq = mintWallet.seq.tx + 1
            transactionData.admin = admin
            // signing was pre-calc'd as miner doesn't have root-chain private key
            // and if we are giving txAuth we must give the hash
            transactionData.txAuth = BLOCKCHAIN_TXAUTH
            transactionData.hash = this.calcHash(transactionData)
        } else {
            // any tokens after base token have an administrator: person who created them.
            const mintWallet = this.Wallet.getUser(this.MINT_TOKEN)
            transactionData.seq = mintWallet.seq.tx + 1
            transactionData.timestamp = time()
            transactionData.admin = this.Wallet.buildNameWithPublicKey(admin)
        }

        // returning genesis transactions initialized
        return [ transactionData ]
    }
    
    getFee({ amount, token = '', type, fee: setFee = 0 }){
        // in BTC network: users can offer to pay a higher fee (may prioritize placement in blocks; we don't offer that)

        // we will allow token to be passed in the amount oo, ex. sol$100 or else amount=100, token = '_sol$'
        { [amount, token] = this.extractTokenFromAmount(amount, token) }
        debug( 5, `<blue>[getFee]</> amount(${amount}) token(${token}) type(${type}) fee(${setFee})`)
        let fee = 0

        if( ['miningReward','miningFees'].includes(type) ) // no 'fees' permitted for system operations
            return fee

        else if( token == this.BASE_TOKEN ) {
            if( type === 'tokenCreate' || type === 'tokenAirdrop' ){
                fee = 0 // base-token token ops are 0-cost
            } else if( FEE_BASE_TRANSACTION >= 0 )
                fee = FEE_BASE_TRANSACTION
            else
                fee = amount * -FEE_BASE_TRANSACTION/100 // negative are percents (ex -10 = 10%)

        } else {
            if( type === 'tokenCreate' )
                fee = FEE_TOKEN_CREATE
            else if( type === 'tokenAirdrop' )
                fee = FEE_TOKEN_AIRDROP    
            else if( FEE_TOKEN_TRANSACTION >= 0 )
                fee = FEE_TOKEN_TRANSACTION
            else
                // if percent we base fee on ratio fo tokens sent vs total tokens available? BUGBUG 
                fee = FEE_TOKEN_TRANSACTION // amount * -FEE_TOKEN_TRANSACTION/100
        }

        if( FEE_MAX > 0 ) fee = Math.min(FEE_MAX, fee)
        fee = Number( Math.max( 0, fee, setFee ) )

        return fixRounding( fee )
    }

    calcHash( transaction ) {
        // clone transaction before removing fields, otherwise pass-by-reference problems!
        const hashableTransaction = { ...transaction }

        // we include ALL transaction fields in hash, except:
        // - non-transaction mining metadata excluded (meta)
        // - signature that is DONE on this hash, thus depends on it
        // - hash itself
        delete hashableTransaction.meta
        delete hashableTransaction.txAuth
        delete hashableTransaction.hash
        // Ethereum and some other blockchains use Keccak-256 as it has better protection against quantum computing
        // But sha256 is strong, and used by BTC and similar ecosystems - we use it
        debug( 4, `<dim><cyan>Calc hash on: ${JSON.stringify(hashableTransaction)}</><reset>`)
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

    checkTransactionCount( transactions, noErrors = false ) {
        let transactionCnt = 0
        // calc how many user transactions in block, we have blockchain limits (to prevent miners from skimping to get more credit, etc)
        for( const t of transactions )
            if( VALID_TRANSACTION_TYPES.includes(t.type) )
                transactionCnt++

        if( noErrors || (transactionCnt >= BLOCK_MIN_TRANSACTIONS && transactionCnt <= BLOCK_MAX_TRANSACTIONS) )
            return transactionCnt
        else
            throw errorWithData(`Need min:${BLOCK_MIN_TRANSACTIONS}/max:${BLOCK_MAX_TRANSACTIONS} user transactions per block, found: ${transactionCnt || '-'}. Rejecting.`, 
            { transactionCnt, min: BLOCK_MIN_TRANSACTIONS, max: BLOCK_MAX_TRANSACTIONS })
    }    

    transactionTypeOperations({ src, dest, type, amount, token, admin, ...data }) {
        if( type === 'tokenCreate' ) {
            // make sure teh wallet exists, else throw error
            this.Wallet.getUser(dest)

            debug( 3, `<cyan> ~ [admin-transaction] found token issue (${dest}) for ${amount} tokens. admin: ${data.admin}`)
            if( admin ) this.Wallet.update(dest, { admin })
        }
        // return { error: false }
    }

    // check transactions are all signed, and seq ok
    auditTransactions( blockMiner, blockIdx, transactions, expectedMiningReward ) {
        debug( 2, `<blue>[auditTransactions]</> blockIdx(${blockIdx}) transactions[${transactions.length}]`)
        let miningReward = 0, miningFees = 0, transactionCnt = 0, adminCnt = 0, transactionError = false

        // genesis block we just accept
        if( blockIdx === 0 ) return { transactionCnt: 0, adminCnt: transactions.length, miningFees: 0 }

        // gather all wallets as we're doing a dry run through transactions
        // then snapshot them as we'll be changing the values in them simulating adding
        // all these transactions, making sure we don't run into negative values, etc.
        const transactionUsers = this.findUsers(transactions)
        
        this.checkTransactionCount(transactions)

        this.Wallet.userSnapshots( transactionUsers )
        this.Wallet.debugOutputLevel = 0 // don's show output while usingit

        try {
            for( const transaction of transactions ){

                // check transaction itself (signing, balances) by doing it - problems throws error
                this.processTransaction(transaction, { blockIdx, manageMempool: false } );

                // check integrity of block structure - return error if not specific allowed types
                if( transaction.type === 'miningReward' ){
                    // one mining reward per block
                    if( transaction.dest.startsWith(blockMiner+':') && transaction.amount == expectedMiningReward && miningReward < 2 ){
                        miningReward++
                        miningFees += transaction.amount
                    } else
                        throw errorWithData( `Block miningReward illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}) for amount(${transaction.amount}). Rejecting.` )

                } else if( transaction.type === 'miningFees' ){
                    // each mining fee must corespond to a signed transaction, the actual value depends what user signed-off to
                    const matchingTransaction = transactions.filter( t => t.hash === transaction.source )
                    if( transaction.dest.startsWith(blockMiner+':') && matchingTransaction.length === 1 &&
                        (matchingTransaction[0].type === 'tokenCreate' || matchingTransaction[0].txAuth?.length > 10) && 
                        matchingTransaction[0].fee == transaction.amount )
                        miningFees += transaction.amount
                    else
                        throw errorWithData( `Block miningFees illegally claimed: miner(${blockMiner}) claimer(${transaction.dest}) for amount(${transaction.amount}). Rejecting.` )

                } else if( transaction.type === 'tokenCreate' ){
                    adminCnt++
                    // mint issue normally only genesis block; unless increasing supply
                    // TODO do we allow outside genesis? && index === 0 ?
                    debug(2,`<cyan>~ Note: admin-level tokenCreate for ${transaction.token} transaction detected</>` )
                } else if( transaction.type === 'tokenAirdrop' ){
                    adminCnt++
                    // check against admin!
                    // should probe back to core system if sanctioned, and what server
                    debug(2,`<cyan>~ Note: admin-level tokenAirDrop transaction detected: ${transaction.amount} >> ${transaction.dest}</>` )
                } else if( TRANSACTION_TYPES_USER.includes(transaction.type )){
                    transactionCnt++

                } else {
                    debug(1,`<red><blink>!</blink></red> transaction #${transaction.hash} txAuth(${transaction.txAuth}) type(${transaction.type}) INVALID.` )
                    throw errorWithData( `Block audit failed: hash(${transaction.hash} txAuth(${transaction.txAuth}) type(${transaction.type}) INVALID` )
                }
            }
        } catch ( e ){
            transactionError = e.message
        } finally {
            // run this regardless 
            this.Wallet.userRestores( transactionUsers )
            this.Wallet.debugOutputLevel = 1
            
            if( !transactionError && miningReward !== 1 )
                transactionError = `Block miningReward claims wrong: allowed one miningReward per block. Rejecting.`
        }
        // an object with transaction error will be returned, else simply false
        if( transactionError ) throw errorWithData( transactionError )
        
        return { transactionCnt, adminCnt, miningFees }

    }

    // when chains confliect, we keep our transactions to attempt rechaining later (dropping system ones)
    filter({ transactions, hashes = [], types = [] }) {
        // organize list of transaction types we want to filter by
        let typeList = []
        if( typeof(types) === 'string' ) types = types.split(',').filter(s => s != '')
        if( types.includes('user') ) typeList.concat( TRANSACTION_TYPES_USER )
        if( types.includes('admin') ) typeList.concat( TRANSACTION_TYPES_ADMIN )
        if( types.includes('system') ) typeList.concat( TRANSACTION_TYPES_ADMIN )
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

    // takes a transaction, and passes back with txAuth + updated hash
    transactionSign({src, dest, amount, token, fee = 0, type = '', seq = 0, txAuth = '', hash, meta, ...data}, signer){
        // build transaction        
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        amount = fixRounding( amount )
        fee = fixRounding( Number(fee || 0) )

        // determine signer
        if( !signer ){
            if( !src.endsWith('$') ){
                signer = src

            } else {
                // if it's a currency, we sign with authorized admin
                // if MINT_TOKEN, we use DEST to sign, else SRC
                // example: *$ -> usd$ : usd$5000 ~~ since *$ is MINT_TOKEN, it uses signer of 'usd$'
                const wallet = (src === this.MINT_TOKEN) ? this.Wallet.getUser(dest) : this.Wallet.getUser(src)
                if( !wallet.admin && !data.admin ){
                    debug( 1, `<red>ERROR: Unable to get signer for token (${wallet.name}), unable to sign.`, wallet )
                    throw errorWithData( `Unable to get signer for token (${wallet.name}), unable to sign.` )
                    // return { error: `ERROR: Unable to get signer for token (${wallet.name}), unable to sign.` }
                }
                signer = wallet.admin || data.admin
            }
        }
        // EXCLUDES [ txAuth, hash, meta ] fields from transaction for hash calculation & signing
        const newTransaction = { src, dest, amount, token, fee, type, timestamp: time(), seq, ...data } 

        // we are signing as of NOW, hence timestamp updated, and then generate fresh hash (that we sign to prove we accepted this)
        const newHash = this.calcHash(newTransaction)
        if( hash && hash !== newHash ){
            debug( 1,`<red>ERROR:</>[transactionSign] Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.`, newTransaction )
            throw errorWithData( `Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.` )
            // return { error: `Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.` }
        }

        // transaction signing possible for:
        //   a) signing-exempt tokens - because issued in parallel on all nodes (mining fees, fees), that sequencing them 
        //      would be a massive bottle-neck -> audit checks they are legitimately claimed
        //   b) supplied external valid txAuth
        //   c) src wallet with _privateKey_ available
        debug( 3, `<blue>[transactionSign]</> src(${src}) type(${type}) signer(${signer}) txAuth(${txAuth})`)
        if( src === this.BASE_TOKEN && TRANSACTION_TYPES_SYSTEM.includes(type) ) { //a)
            // system-level src, signing-exempt
            debug( 4, `   ~ ${src}/${type} -> signing exempt` )

        } else if( txAuth ){ // b)
            // verify the sig given is valid
            const [ signerName, signedHash ]= txAuth?.split(':')
            const decodedHash = this.Wallet.decode(signer, signedHash)
            if( decodedHash !== newHash ){
                debug( 1,`<red>ERROR:</> xx Signature of ${signerName} was INVALID, rejecting transaction.`)
                throw errorWithData( `[transactionSign] Transaction signature (for: ${signerName}) was INVALID, rejecting.` )
            }

        } else { // c)
            // wasn't signed, BUT we have the private key, so we assume it's from a sanctioned system, we'll sign it
            txAuth = this.Wallet.sign(signer, newHash)
        }

        if( txAuth ) newTransaction.txAuth = txAuth
        if( meta ) newTransaction.meta = meta
        newTransaction.hash = newHash

        return newTransaction
    }

    // builds transaction (mostly in the transactionSign() method), checks seq is ok
    addSeqAndSign({src, dest, amount, token, fee = 0, type = '', seq = 0, txAuth = '', hash, ...data}, options = {}){
        const { blockIdx = -1, txUpdate = false, reverse = false }= options

        let newTransaction

        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        if( reverse ){
            amount = -amount
            fee = -fee
        }

        src = this.Wallet.buildNameWithPublicKey(src)
        dest = this.Wallet.buildNameWithPublicKey(dest)

        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        
        // type must be valid
        if( !VALID_TRANSACTION_TYPES.includes(type) ){
            throw errorWithData( `Unknown transaction type(${type}); hash(${hash}): choices(tokenAirDrop; minerDeposit; transfer) Rejecting.` )
            // return { error: `Unknown transaction type(${type}); hash(${hash}): choices(tokenAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( reverse ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            newTransaction = { timestamp: time(), src, dest, amount, token, fee, type: `rollback:${type}`, hash: '', source: hash,  ...data }
            return newTransaction
        }
        
        // determine SEQ ----------
        const srcWallet = this.Wallet.getUser(src)
        if( src === this.BASE_TOKEN && TRANSACTION_TYPES_SYSTEM.includes(type) )
            seq = 0 // signing-exempt don't use seq
        else if( seq < 1 ) 
            seq = srcWallet.seq.tx + 1 // auto-gen it as it doesn't need signed trans with seq (ex admins)
        else {
            // we need a seq that is valid and +1 on tx or onChain (depending on if trans is being done for writing block or just mempool)
            // SIGNING REQUIRED (seq NEEDED!) -- TODO should queue it up and look later (ex. if out of order), for onChain know that trans related to a block?
            // debug( 'green', `[ledger::transaction] (${srcWallet.name}/${seq}) blockIdx(${blockIdx}) trans-seq(${seq}) tx.seq(${srcWallet.seq.tx}) onChain.seq(${srcWallet.seq.onChain}) `)
            if( blockIdx === -1 && seq !== (srcWallet.seq.tx + 1) )
                throw errorWithData( `X transaction [${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount} rejected - need seq = srcWallet.seq.tx+1(${srcWallet.seq.tx+1})...`, 
                        { blockIdx, seq: srcWallet.seq.tx, balance: Number(srcWallet[token]?.tx.balance) } )
            else if( blockIdx > -1 && seq !== (srcWallet.seq.onChain + 1) )
                throw errorWithData( `X transaction [${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount}] rejected - block#${blockIdx}; need seq = onChain.seq+1(${srcWallet.seq.onChain+1})..`, 
                        { blockIdx, seq: srcWallet.seq.onChain, balance: Number(srcWallet[token]?.onChain.balance) } )
        } 
                
        // SIGN IT (attempt at least) using seq determined above
        debug( 3,`<blue>[addSeqAndSign]</> transaction ${srcWallet.name}/${seq} -> ${this.Wallet.getNameOnly(dest)||dest}  ${token}${amount})`)
        newTransaction = this.transactionSign({src, dest, amount, token, fee, type, seq, txAuth, hash, ...data})
        debug( 4,`  <gray>~ signing complete (${newTransaction.txAuth && newTransaction.txAuth.substring(0,30)+'...'})</>` )
        return newTransaction
    }

    checkTokenBalances({src, dest, amount, token = '', fee = 0, type = '', seq = 0, txAuth = '', hash = '', meta, ...data}, options = {}){
        const { blockIdx = -1 }= options

        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        // no balance check for minter, unlimited token creation
        if( src === this.MINT_TOKEN ) {
            debug( 3,`~ System Token Issue Transaction for: [${token}]${amount}`)
            return { balance: 1000000000000 }
        }

        const srcName = this.Wallet.getNameOnly(src)
        let feeWallet, srcWallet
        try {
            srcWallet = this.Wallet.getUser(src)
        } catch( e ) {
            // check this wallet actually has this token; and if it's a token-account, exists on node
            if( srcName.endsWith('$') )
                throw errorWithData( `${srcName} token not available on node, create it? Rejecting.`, { src, blockIdx } )
            else
                throw errorWithData( `${srcName} account not known on node. Rejecting.`, { src, blockIdx } )
        }

        if( !srcWallet[token] )
            throw errorWithData( `${srcName} does not have any ${token}. Rejecting.`, { src, token, blockIdx } )

        // quicklink the balance field we will be using
        srcWallet[token].balance = blockIdx === -1 ? 
                      Number(srcWallet[token].tx.balance)
                    : Number(srcWallet[token].onChain.balance)
        if( fee > 0 && src.includes('$') ) {
            feeWallet = this.Wallet.getUser( srcWallet.admin ) // fee = 0 for *root user, so this means its a user-token
            feeWallet[this.BASE_TOKEN].balance = blockIdx === -1 ? 
                      Number(feeWallet[this.BASE_TOKEN].tx.balance)
                    : Number(feeWallet[this.BASE_TOKEN].onChain.balance)
            debug( 3, `<magenta>[checkTokenBalances]</> src(${this.Wallet.getNameOnly(src)}) amount(${amount}) fee(${fee}) admin: ${this.Wallet.getNameOnly(srcWallet.admin)}; balance: ${feeWallet[this.BASE_TOKEN].balance}`)
        } else {
            feeWallet = srcWallet
        }

        // note objects are linked if same person so both 'balances' go down.
        srcWallet[token].balance -= amount
        feeWallet[this.BASE_TOKEN].balance -= fee
        debug( 4, `[checkTokenBalances] srcName(${srcName}) balance after (${amount}): ${srcWallet[token].balance}; and feeWallet after fee (${fee}) ${feeWallet[this.BASE_TOKEN].balance}`)

        if( srcWallet[token].balance < 0 )
            throw errorWithData( `${srcName} balance(${token}${srcWallet[token].balance}) less than transaction amount(${token}${amount}+fee)=${token}${amount+fee}. Rejecting.`, { src, balance: srcWallet[token].balance, blockIdx })
        else if( feeWallet[this.BASE_TOKEN].balance < 0 )
            throw errorWithData( `Insufficient balance for fees (${this.BASE_TOKEN}${fee} by ${feeWallet.name}.`, { src, blockIdx })

        // update balance for meta data passed back (non-commital value), but not used for internal calculations
        // const balance = fixRounding((blockIdx === -1 ? srcWallet[token].tx.balance : srcWallet[token].onChain.balance) - (amount+fee))
        // this.updateMeta( [newTransaction], 'balance', balance)
        if( this.debugOutputLevel ){
            debug(5,`~ #${blockIdx}:transaction${reverse?' *REVERSED*':''} [${srcName}${seq>0 ?'/'+seq:''}${srcWallet.privateKey?'[Signed]':''}`
                        +` -> ${this.Wallet.getNameOnly(dest)||dest} ${token}${amount}] / ${newTransaction.type || ''} `+( fee ? `fee(${fee}) `  : '') + (txUpdate ? '[txUpdate]' : '' ) 
                        + (seq>0 || srcWallet.seq.tx>0 || srcWallet.seq.onChain>0 ? ` seq(${seq}) seq.tx(${srcWallet.seq.tx}) seq.onChain(${srcWallet.seq.onChain})` : '') )
            this.Wallet.balances([src,dest])
        }

        return { balance: srcWallet[token].balance }
    }

    walletTxBalanceUpdate({ wallet, amount, token, seq, reverse = false }) {
        const tokenTx = wallet[token].tx
        tokenTx.amount = amount
        tokenTx.balance = fixRounding( Number(tokenTx.balance) + Number(amount) )
        if( seq ) wallet.seq.tx = !reverse ? Math.max(seq, wallet.seq.tx, wallet.seq.onChain) : wallet.seq.onChain
        debug(5,`~ [walletTxBalanceUpdate] tx.balance + (${token}${amount}) seq(${wallet.seq.tx || 'n/a'})`)
    }

    walletOnChainBalanceUpdate({ wallet, amount, token, seq, reverse = false, blockIdx }) {
        const tokenOnChain = wallet[token].onChain
        tokenOnChain.amount = amount
        tokenOnChain.balance = fixRounding( Number(tokenOnChain.balance) + Number(amount) )
        if( seq ) wallet.seq.onChain = !reverse ? seq : Math.max( seq-1, 0 )
        if( !reverse ){
            if( !tokenOnChain.historyIdx.includes(blockIdx) ) tokenOnChain.historyIdx.unshift(blockIdx) // prepend block
        } else {
            // Remove the specific block index when reversing
            if( tokenOnChain.historyIdx.includes(blockIdx) ) {
                const indexToRemove = tokenOnChain.historyIdx.indexOf(blockIdx)
                tokenOnChain.historyIdx.splice(indexToRemove, 1)
            }
        }
        tokenOnChain.historyIdx = tokenOnChain.historyIdx.slice(0,10) || []
        debug(5,`~ [walletOnChainBalanceUpdate] onChain.balance + (${token}${amount}) seq(${wallet.seq.onChain || 'n/a'})`)
    }

    walletTransaction({ name, amount, token, seq }, options = {}){
        const { blockIdx = -1, txUpdate = false, reverse = false }= options

        const wallet = this.Wallet.getUser(name)

        // if this token not in system, create it
        if( !wallet[token] ) this.Wallet.initToken( wallet, token )

        // if blockIdx -1: transaction mempool only; else onChain, and if it wasn't mempool'd first, we update mempool tally (txUpdate:true)
        if( blockIdx > -1 ) // block provided, so wallet onChain settings updated
            this.walletOnChainBalanceUpdate({ wallet, amount, token, seq, reverse, blockIdx })
        
        if( blockIdx === -1 || txUpdate ) // mempool transaction, OR txUpdate flag set
            this.walletTxBalanceUpdate({ wallet, amount, token, seq, reverse })

        debug(5,`     ~ [walletTransaction] ${this.Wallet.getNameOnly(name)} ${token}${amount} blockIdx(${blockIdx}) txUpdate(${txUpdate}) tx.balance(${wallet[token].tx.balance}) onChain.balance(${wallet[token].onChain.balance})`)
        
        // let's write it!
        this.Wallet.update( name )
        // console.log( ` ...[walletTransactionData](${walletAddress}) token=(${token})Update:`, JSON.stringify({ onChain, tx }))
        // debug(this.debugOutputLevel ? 'green' : 5, `        ${walletAddress.split(':')[0]} +tx(${wallet.tx.amount})=(${wallet.tx.balance}) +chain(${wallet.onChain.amount})=(${wallet.onChain.balance})`)
    }

    // update the wallet values
    // if a block#, does onChain; if no block# does tx; if block# + txUpdate, does BOTH
    walletTransactionData({ src, dest, amount, token, fee, seq, blockIdx = -1, txUpdate = false, reverse = false }) {
        // extract token from amount if present, ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        if( !src || !dest || amount == 0 )
            throw errorWithData( `Missing parameter (src: ${src}, dest: ${dest}, amount: ${token}${amount}` )
        // debug(5,`     ~ [walletTransactionData] ${src} --------------------------------------` ) 
        amount = fixRounding( amount )
        fee = fixRounding( Number(fee || 0) )

        // _src_ user: deduct amount
        this.walletTransaction({ name: src, token, amount: -amount, seq}, { blockIdx, txUpdate, reverse })
        
        // _dest_ user: add amount
        this.walletTransaction({ name: dest, token, amount }, { blockIdx, txUpdate, reverse })
        
        // deduct fee
        if( Number(fee)>0 ){
            // _src_ user: deduct fee
            debug(5,`~ FEE: ${fee} deducted from ${src}`)
            this.walletTransaction({ name: src, token: this.BASE_TOKEN, amount: -fee }, { blockIdx, txUpdate, reverse })
            // _token_ pool: return fee -> token pool will pay out to the miner upon block mint
            this.walletTransaction({ name: this.BASE_TOKEN, token: this.BASE_TOKEN, amount: fee }, { blockIdx, txUpdate, reverse })
        }
    }

    rewardTransaction(transaction, blockIdx) {
        // extract token from amount if present, ex. sol$100
        transaction = this.addSeqAndSign(transaction,{ blockIdx })
        this.checkTokenBalances(transaction,{ blockIdx })

        return transaction
    }

    // prepare a transaction for miner (so adjust pending layer too)
    // addSeqAndSign + Memool.Queue.add + walletTransaction
    processTransaction({src, dest, amount, token = '', type, fee = 0, seq = 0, txAuth = '', hash, ...data}, options = {} ) {
        const { blockIdx = -1, txUpdate = false, manageMempool = true }= options

        // Validate transaction
        if (!src || !dest || !amount) {
            debug(1,`<red>ERROR</> Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.`)
            throw errorWithData( `Invalid transaction (src: ${src}, dest: ${dest}, amount: ${amount}). Rejecting.` )
        }

        // extract token from amount if present, ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }
        fee = this.getFee({ amount, token, fee, type })

        let transaction = {src, dest, amount, token, type, fee, seq, txAuth, hash, ...data}

        // there are only 2 states:
        // - in mempool: already processed, so just update onchain amount
        // - new: do full processing
        const alreadyExists = hash && this.Mempool.Hashes.exists(hash) ? true : false
        let log = `[${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(dest)}] ${token}${amount} `

        if( alreadyExists ) {
            if( blockIdx > -1 ) {
                log += ` [existing hash/block=${blockIdx}: onChain wallet bump.]`
                if( manageMempool ){
                    this.Mempool.Hashes.updateBlockIdx(hash,blockIdx)
                    // delete queue entry 
                    this.Mempool.Queue.delete( hash )
                    log += ` (deleted mempool-queue + updated hash)`
                }
                this.walletTransactionData({ ...transaction, blockIdx, txUpdate: false })
                return transaction

            } else {
                log += ` [Duplicate mempool request. Ignoring.]`
                debug(5, `~ [processTransaction] ${log}`)
                throw errorWithData( `Existing: [${this.Wallet.getNameOnly(src)}/${seq} -> ${this.Wallet.getNameOnly(dest)} [${token}]${amount}], duplicate/old tx entry. Ignoring.`, { updateSeq: true, index: blockIdx })
            }
        }

        // NEW TRANSACTION - process fully
        log += ` [NEW (block=${blockIdx}): sign + en-Queue + wallet tx/onChain bump.]`

        let warning = data.meta?.warning || '' // pre-set warning with any prior meta-data from it

        const { balance } = this.checkTokenBalances(transaction,{ blockIdx })
        transaction = this.addSeqAndSign(transaction,{ blockIdx, txUpdate })
        this.updateMeta( [transaction],'balance', balance )

        // any type-specific operations
        this.transactionTypeOperations(transaction)
        
        // MEMPOOL
        if( blockIdx === -1 ){
            // no mempool entry, and we're just queuing it
            if( manageMempool ) {
                this.Mempool.Queue.add( transaction )
            }

            let warning = ''
            for( const t of this.Mempool.Queue.filter('src',transaction.src) )
                if( t.meta?.miner && t.meta.miner !== this.nodeName ) warning += `queued also on ${t.meta.miner}; `
            if( warning ) this.updateMeta( [transaction],'warning',warning )

            // indicate queue time
            this.updateMeta( [transaction],'queueTime',time() )

        } else {
            // no hash entry, create one, indicating the blockIdx
            if( manageMempool ) {
                this.Mempool.Hashes.updateBlockIdx(transaction.hash,blockIdx)
            }
        }

        debug( 3, `~ [processTransaction] ${log}`)

        // update wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        this.walletTransactionData({ ...transaction, blockIdx, txUpdate: true })
        
        // now if we got the error with pending posted on multiple servers, lets' have that warning appear here
        if( warning ){
            this.updateMeta([transaction],'warning',warning)
            debug( 3,`<green>\\ ! attached warning: "${warning}"</>` )
        }

        return transaction
    }

    processTransactions( transactions, options = {} ){
        const { blockIdx = -1, txUpdate = false }= options

        // run ledger transaction & add to hash list
        let newHashes = [], deleteHashes = [], hashes = [], resultTransactions = [], error = '', transactionCnt = 0

        if( blockIdx>-1 ) debug( 3,`\n<cyan>- [block#${blockIdx}]: (transactions: ${transactions.length})</> ------------------------------------------------------------------------` )
        for( const transaction of transactions ){
            let resultTransaction
            try { 
                resultTransaction = this.processTransaction(transaction, options)
                resultTransactions.push( resultTransaction )
                transactionCnt++
                newHashes.push( resultTransaction.hash )
            } catch( e ) {
                if( this.Mempool.Hashes.findBlockIdx(hash) === -1 ){s
                    // failed so delete hash-look-up reference to this transaction hash
                    debug( 5, `   .. ${e.message} (Failed transaction; deleting hash)`)
                    deleteHashes.push( hash )
                    this.Mempool.Hashes.delete( hash )
                    // delete this.hashes[transaction.hash]
                    hashes.pop()
                } else {
                    // failed, but likely innocuous: already exists, so continuing
                    debug(5,`  ..${e.message}`)
                }
                error += e.message + ','
            } finally {
                const hash = transaction.hash || resultTransaction.hash
                hashes.push( hash )
            }
        }

        if( error ) throw errorWithData( error )
        return { transactions: resultTransactions, transactionCnt, hashes, newHashes, deleteHashes }
    }

    syncTxToChain( addresses, minerTokens = false ){
        // addresses { name1: [ USDC, USDB ] }
        if( minerTokens ){ 
            // gather token accounts for this miner
            addresses = { [this.nodeName]: this.Wallet.findUsers('$') }
            debug( 3, `<cyan>[TransactionHandler::syncTxToChain]</> tokens active on this node; will sync tx >> onChain`, addresses )
        } else {
            debug(5,`[TransactionHandler::syncTxToChain] for addresses:`, addresses)
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
                
                if( wallet[token] && wallet[token].tx.balance !== wallet[token].onChain.balance ){
                    debug( 3, `~ <cyan>[revertTxToChain]</> ${wallet.name} ${token} no pending but chain diff: tx.balance(${wallet[token].tx.balance}) onChain.balance(${wallet[token].onChain.balance}), sync to onChain value.`)
                    wallet[token].tx.amount = wallet[token].onChain.amount
                    wallet[token].tx.balance = wallet[token].onChain.balance
                    wallet.seq.tx = wallet.seq.onChain // Math.max(wallet.tx.seq, wallet.onChain.seq) // Don't move tx.seq backwards
                }
            }
        }
    }
    
    // when we fail to mine a block, since we'll be retrying, don't reverse any ledger balances (yet)
    clearBlockMempool( transactions ){
        let pending = 0, undo = 0
        for( const transaction of transactions ){
            if( transaction.hash && this.Mempool.Hashes.exists(transaction.hash) ){
                // user transactions we'll retry - so don't reverse ledger
                debug(5,`    ~ ${this.Wallet.getNameOnly(transaction.src)}/${transaction.seq} >> ${this.Wallet.getNameOnly(transaction.dest)} [${transaction.token}]${transaction.amount} [${transaction.type}] -> reverted to mempool.`)
                this.Mempool.Hashes.clearBlockIdx(transaction.hash)
                pending++
            }
        }
        return { pending }
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
        if( !transactions ) return []
        return transactions.map( ({meta, ...data})=> data )
    }

    reverse({src, dest, amount, token, fee, seq, hash, ...data}){
        if( !hash || hash.length<40 ) return { error: `Invalid hash!`}

        // extract token from amount (if present), ex. sol$100
        { [amount, token] = this.extractTokenFromAmount(amount, token) }

        const index = this.Mempool.Hashes.findBlockIdx(hash)

        // if wasn't found at all, nothing to reverse
        if( index === false ){
            debug(5,`    ~ x no hash index entry found, so nothing more to do.`)
            // this.pending = this.pending.filter( t => t.hash !== hash )
            return { index: '' }
        }

        if( index === -1 ){
            debug(5, `    ~ ${this.Wallet.getNameOnly(src)}/${seq} >> ${this.Wallet.getNameOnly(dest)} $${amount} -> removing mempool entry + removed hash.`)
            this.Mempool.Queue.delete([hash])
        }
        
        const options = { blockIdx: index, txUpdate: true, reverse: true }
        const transactionData = {src, dest, amount, token, fee, seq, hash, ...data}
        const transaction = this.addSeqAndSign(transactionData, options)
        this.checkTokenBalances(transaction,{ blockIdx })

        // reverse wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        this.walletTransactionData({ ...transaction, ...options })

        return transaction
    }

    reverseBatch( transactions ){
        let deleted = 0

        transactions.forEach( t => {
            // we do blockchain.transactionReverse as we do not want to remove from pending, will try again, new block#!
            this.reverse(t)
            deleted++
        })
        return { error: false, deleted }
    }
    
}
