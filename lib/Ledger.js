
/**************************************************************************
 * Simple Fully Functional Blockchain Example
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This is the LEDGER class, so wallet and transactional concepts should 
 * be focused here
 * ***********************************************************************/

import fs from 'fs'
import path from 'path'
// generates 32-byte ed25519 keys (more compact) than crypto library
import nacl from 'tweetnacl'
// using bs58 as its just ascii characters
import bs from 'bs58'
import { urlCall, sha256Hash, fixRounding, time, debug } from './helper.js'

const TRANSACTION_TYPES = ['mintIssue','mintAirDrop','miningReward','miningFees','minerDeposit','transfer']

export default class Ledger {
    constructor(ledgerFile = '') {
        this.wallets = {}
        this.snapshots = {}
        this.maxBlockIdx = 0
        this.debugOutputLevel = 1
        this.ledgerFile = ''
        // read the wallet file
        if( ledgerFile ){
            const directory = path.dirname(ledgerFile)
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
            const basename = path.basename(ledgerFile).indexOf('.json')>0 ? path.basename(ledgerFile) : 'ledger.json' // default if not given
            this.ledgerFile = path.join(directory, basename);

            let jsonData = fs.existsSync(this.ledgerFile) ? fs.readFileSync(this.ledgerFile, 'utf8').trim() : '{}'
            this.wallets = JSON.parse( jsonData )
        }
    }

    // we re-create the transactions, but keep other stuff like public/private keys shared
    reset(){
        const addresses = Object.keys(this.wallets)
        addresses.forEach( publicKey => {
            // reset wallet transactions as we re-tabulate them, breaks reference points in case
            const wallet = this.wallets[publicKey]
            this.wallets[publicKey] = {
                ...wallet,
                onChain: { seq: 0, amount: 0, balance: 0, historyIdx: [] },
                tx: { seq: 0, amount: 0, balance: 0 }
            }            
        })
    }

    checksumPublicKey(publicKey, genMode = true) {
        // only use first 44 bytes
        const bytes = bs.decode(publicKey.slice(0,44))
        const checksum = bytes.reduce((sum, byte) => (sum + byte) % 58, 0)
        const checksum58 = bs.encode(Buffer.from([checksum]))

        // genMode gives checksum, else it checks last char against checksum
        return genMode ? checksum58 : checksum58 == publicKey.slice(-1)
    }
    
    buildTransactionName(name, publicKey = '') {
        if( !publicKey && !name.includes(':') ){
            publicKey = this.getPublicKey(name)
            if( publicKey.error ) return publicKey
        }

        if( publicKey && !name.startsWith('_') && name !== publicKey && !name.includes(':') ) 
            name += ':' + publicKey
        return name
    }

    // for readability, we allow a more flexible address system
    // user:publicKey are sent, but we can look-up just by user name
    getPublicKey(name) {
        // admin-levels don't have public keys, use name
        if( !name ) 
            return { error: 'Empty name' }
        else if( typeof(name)==='object' )
            return name.publicKey || { error: 'Wallet without publicKey' }
        else if( name.startsWith('_') ) // admins don't need publicKey, so just return name
            return name

        let publicKey = ''
        if( name.indexOf(':')>1 )
            publicKey = name.split(':')[1]
        else if( name.length == 45 )
            publicKey = name
        else if( name.length>1 ) {
            // publicKey unknown, scan 'name' fields in addressbook
            const arrayAddresses = Object.values(this.wallets)
            const wallet = arrayAddresses.filter(item => item.name === name)
            // there may be multiple wallets with same name (ex. if delete/restarting node, but FIRST is active)
            if( wallet.length > 0 && wallet[0].publicKey )
                publicKey = wallet[0].publicKey
        }

        if( publicKey.length < 1 ){
            // debug('red',`Public Key for ${name} NOT found in local wallets`)
            return { error: `Public Key for ${name} NOT found in local wallets`}
        } else if( publicKey.length !== 45 ) 
            return { error: `Public Key (${publicKey}) length (${publicKey.length}) for ${name} wrong.`}

        if( !this.checksumPublicKey(publicKey,false) ){
            return { error: `Public Key for ${name} INVALID checksum, typo?`}
        }

        return publicKey
    }

    getWallet(name) {
        const publicKey = this.getPublicKey(name)
        if( publicKey.error ) return { ...publicKey }

        // if there's a name lets remember it
        if( name.indexOf(':')>1 ) 
            name = name.split(':')[0]

        // if no wallet create
        if( this.wallets[publicKey] === undefined )
            this.wallets[publicKey] = { name, created: time(), publicKey, onChain: {seq: 0, amount: 0, balance: 0, historyIdx: []}, tx: {seq: 0, amount: 0, balance: 0} }

        return this.wallets[publicKey]
    }

    createWallet(name) {
        if( !name || name.startsWith('_') || name.indexOf(':')>0 ) 
            return { error: `You need to give a name for the wallet (cannot *start* with (_); cannot have a colon(:) in it)` }

        // if user exists, check if privateKey, if not, we add it, if no user, we create that user too!
        let userWallet = this.getWallet(name)
        if( !userWallet.privateKey && !userWallet.publicKey){
            debug('dim',` - No existing publicKey or privateKey for (${name}); creating public/privateKeys`)
            // Generate a new key pair, soemtimes 43 chars, so retry creating new till 44
            let tryCnt = 0, publicKey = '', privateKey = ''
            do {
                const keyPair = nacl.sign.keyPair()
                publicKey = bs.encode(Buffer.from(keyPair.publicKey))
                privateKey = bs.encode(Buffer.from(keyPair.secretKey))
            } while( publicKey.length !== 44 && tryCnt++<50 )            
            publicKey += this.checksumPublicKey(publicKey) // append a checksum character
            userWallet = this.updateWallet(name, { name, publicKey, privateKey })
            userWallet.name = name.indexOf(':')>1 ? name.split(':')[0] : name
        } else if( !userWallet.privateKey && userWallet.publicKey ){
            // debug('red',`*${name}* already has a publicKey associated. If we generated privateKey, we would change publicKey. Create another user name instead.`)
            return { error: `*${name}* already has a publicKey associated. If we generated privateKey, we would change publicKey. Create another user name instead.` }
        }

        return userWallet
    }

    updateWallet(name, walletData={}) {
        let publicKey = this.getPublicKey(name)
        // need publicKey somewhere, not in name? not in passed-in data? error!
        if( publicKey.error && !walletData.publicKey )
            return publicKey

        if( publicKey.error && walletData.publicKey )
            publicKey = walletData.publicKey

        // upon creation need seq/balance; and of course publicKey cannot be changed
        // spreads overwrite sub-objects, so we rebuild tx & onChain first
        const tx =  { seq: 0, amount: 0, balance: 0, ...this.wallets[publicKey]?.tx, ...walletData?.tx }
        const onChain = { seq: 0, amount: 0, balance: 0, historyIdx: [], ...this.wallets[publicKey]?.onChain, ...walletData?.onChain }
        const wallet = { ...this.wallets[publicKey], ...walletData, onChain, tx, publicKey }

        // got a unique name, let's save it - else it becomes generic publicKey
        if( name.indexOf(':')>1 )
            wallet.name = name.split(':')[0]
        
        this.wallets[publicKey] = wallet

        // update ledger file
        fs.writeFileSync(this.ledgerFile, JSON.stringify(this.wallets))

        return wallet
    }
    
    calcHash(transactionData) {
        // clone transaction before removing fields, otherwise pass-by-reference problems!
        const hashData = { ...transactionData }

        // we include ALL transaction fields in hash, except:
        // - non-transaction mining metadata excluded (meta)
        // - signature that is DONE on this hash, thus depends on it
        // - hash itself
        delete hashData.meta
        delete hashData.txSig
        delete hashData.hash
        // Ethereum and some other blockchains use Keccak-256 as it has better protection against quantum computing
        // But sha256 is strong used by BTC and similar ecosystems - encode bs58 to make it shorter with alpha chars vs hex
        return bs.encode(sha256Hash(hashData))
    }
    
    transactionSign({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}){
        const publicKey =  this.getPublicKey(src)            
        if( publicKey.error ) return publicKey

        const destPublicKey =  this.getPublicKey(dest)
        if( destPublicKey.error ) destPublicKey

        // append public key to src/dest
        src = this.buildTransactionName(src, publicKey)
        if( src.error ) return src
        dest = this.buildTransactionName(dest, destPublicKey)
        if( dest.error ) return dest

        // build transaction
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )

        const newTransaction = { timestamp: time(), src, dest, amount, fee, type, seq, ...data } // exclude txSig, hash, meta from transaction 
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

        } else if( txSig && publicKey ){ // b)
            // verify the sig
            if( !this.walletVerify(publicKey, txSig, newHash) ){
                if( this.debugOutputLevel ) debug('red',` xx Signature was INVALID, rejecting transaction.`)
                return { error: `Transaction signature was INVALID, rejecting.` }
            }

        } else { // c)
            // at this point, no txSig, not admin-level, so we need privateKey
            const srcWallet = this.getWallet(src)

            if( srcWallet.error || !srcWallet.privateKey ) 
                return { error: `Unable to sign transaction: ${!srcWallet.privateKey ? `Missing privateKey for (${src})`: srcWallet.error}; Declining.` }

            // wasn't signed, BUT we have the private key, so we assume it's from a sanctioned system, we'll sign it
            txSig = this.walletSign(srcWallet.privateKey, newHash) 
        }

        if( txSig ) newTransaction.txSig = txSig
        newTransaction.hash = newHash

        return newTransaction
    }

    transaction({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', meta, ...data}, options = {}){
        const { blockIdx = -1, txUpdate = false, testOnly= false, reverse = false }= options
        // all other transaction fields don't affect us, so include directly
        let newTransaction

        if( reverse ){
            amount = -amount
            fee = -fee
        }

        // signed ok; now check if has src has balance (if non-admin user)
        const srcWallet = this.getWallet(src)
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        
        // type must be valid
        if( !TRANSACTION_TYPES.includes(type) ){
            return { error: `Unknown transaction type(${type}); hash(${hash}): choices(mintAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( reverse ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            newTransaction = { timestamp: time(), src, dest, amount, fee, type: `reversal:${type}`, hash: '', source: hash,  ...data }

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
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${dest.split(':')[0]||dest} $${amount}] rejected - need seq = srcWallet.tx.seq+1(${srcWallet.tx.seq+1})...`, 
                            blockIdx, seq: srcWallet.tx.seq, balance: Number(srcWallet.tx.balance) }
                else if( blockIdx > -1 && seq !== (srcWallet.onChain.seq + 1) )
                    return { error: `X transaction [${srcWallet.name}/${seq} -> ${dest.split(':')[0]||dest} $${amount}] rejected - block#${blockIdx}; need seq = onChain.seq+1(${srcWallet.onChain.seq+1})..`, 
                            blockIdx, seq: srcWallet.onChain.seq, balance: Number(srcWallet.onChain.balance) }
            } 
                 
            // SIGN IT (attempt at least) using seq determined above
            newTransaction = this.transactionSign({src, dest, amount, fee, type, seq, txSig, hash, ...data})
            if( newTransaction.error ) return newTransaction
            newTransaction.meta = meta || {} // add back mining-server meta-data passed in

            // check ledger balance sufficient (genesis issuer '_' excluded)
            if( src === '_' ) {
                debug('dim',`    ~ Mint Issue Transaction for: $${amount}`)

            } else if( blockIdx === -1 && Number(srcWallet.tx.balance) < (amount+fee) ){
                return { error: `${src.split(':')[0]} balance(${srcWallet.tx.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet.tx.balance) }

            } else if( blockIdx > -1 && Number(srcWallet.onChain.balance) < (amount+fee) ){
                return { error: `${src.split(':')[0]} onChain balance(${srcWallet.onChain.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet.onChain.balance) }
            }

            // update balance for meta data passed back (non-commital value), but not used for internal calculations
            newTransaction.meta.balance = fixRounding((blockIdx === -1 ? srcWallet.tx.balance : srcWallet.onChain.balance) - (amount+fee))
        }
        // update wallet balances - if txUpdate true it will do wallet tx at same time as onChain
        if( !testOnly ) this.transactionWalletUpdate({ src, dest, amount, fee, seq, blockIdx, txUpdate, reverse })

        if( this.debugOutputLevel ){
            debug('cyan',`  ~ #${blockIdx}:transaction${reverse?' *REVERSED*':''} [${src.split(':')[0]}${seq>0 ?'/'+seq:''}${srcWallet.privateKey?'[Signed]':''}`
                        +` -> ${dest.split(':')[0]||dest} $${amount}] / ${newTransaction.type || ''} `+( fee ? `fee(${fee}) `  : '') + (txUpdate ? '[txUpdate]' : '' ) 
                        + (seq>0 || srcWallet.tx.seq>0 || srcWallet.onChain.seq>0 ? ` seq(${seq}) tx.seq(${srcWallet.tx.seq}) onChain.seq(${srcWallet.onChain.seq})` : '') )
            //filter( item=>[src,dest].includes(item.name) ).
            this.walletBalances([src,dest])
        }
        return newTransaction
    }

    // update the wallet values
    // if a block#, does onChain; if no block# does tx; if block# + txUpdate, does BOTH
    transactionWalletUpdate({ src, dest, amount, fee, seq, blockIdx = -1, txUpdate = false, reverse = false }) {
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
            const wallet = this.getWallet(walletAddress)
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

            result = this.updateWallet( walletAddress, { onChain, tx })
            // debug(this.debugOutputLevel ? 'green' : 'dim', `        ${walletAddress.split(':')[0]} +tx(${wallet.tx.amount})=(${wallet.tx.balance}) +chain(${wallet.onChain.amount})=(${wallet.onChain.balance})`)
            if( result.error ) return result
            idx++
        }
        return { error: false }
    }
    
    walletSnapshots( wallets ){
        let snapCnt = 0
        for( const name of wallets ){
            const publicKey = this.getPublicKey(name)
            if( publicKey.error ) return publicKey

            this.snapshots[publicKey] = JSON.stringify(this.wallets[publicKey] || {})
            snapCnt++
        }
        return { error: false, snapCnt }
    }

    walletRestores( wallets ){
        let restoreCnt = 0
        for( const name of wallets ){
            const publicKey = this.getPublicKey(name)
            if( publicKey.error ) return publicKey

            this.wallets[publicKey] = JSON.parse(this.snapshots[publicKey])
            restoreCnt++
        }
        return { error: false, restoreCnt }
    }

    walletBalances(names = [], compact = false ) {
        let balances = {}
        let wallets = Object.values(this.wallets)
        let publicKeys = []
        if( names.length>0 ){
            publicKeys = names.map( n => this.getPublicKey(n) )
            wallets = wallets.filter( i=> publicKeys.includes( i.publicKey ) )
        }
        
        // add chain-depth
        // BUGBUG TODO display is for debugging ONLY 
        if( compact ){
            return publicKeys.map( publicKey => `${this.wallets[publicKey].name}: $${this.wallets[publicKey].tx.balance}` ).join(',')

        } else {
            debug('dim',`   = Name =${' '.repeat(14)} = TX Balance =${' '.repeat(9)} = Block Balance =${' '.repeat(2)} = Depth =  = Block History =`)
            wallets.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)).forEach( i=>{
                const name = i.name.length>19 ? i.name.substring(0,17)+'...' : i.name 
                if( !(names.length===0 && name === '_') && i.tx.balance>0 ){
                    let seqInfo = i.tx?.seq > 0 || i.onChain?.seq > 0 ? `${i.tx.seq},${i.onChain.seq}` : ''
                    seqInfo = !seqInfo ? ':' : '/' + seqInfo + ':'
                    const onChainBal = (i.tx.balance === i.onChain.balance ? '"' : i.onChain.balance) || '0'
                    const onChainDepth = i.onChain.historyIdx.length > 0 ? Math.max(0,this.maxBlockIdx - i.onChain.historyIdx[0]) : 0
                    debug('dim',`   - ${name}${seqInfo}${' '.repeat(20-(seqInfo.length+name.length))} $ ${i.tx.balance || '0'} `
                               +`${' '.repeat(20-(i.tx.balance||'0').toString().length)} $ ${onChainBal} `
                               +`${' '.repeat(22-(onChainBal.toString().length+onChainDepth.toString().length))} ${onChainDepth}`
                               +`       ${i.onChain.historyIdx || '-'}`)
                    
                }
                })
        }
        // don't pass out privateKey EVER - but all other info from the wallet is ok
        // add in depth
        return wallets.map( ({ privateKey, ...data }) =>{ return { ...data, depth: data.onChain.historyIdx.length > 0 ? Math.max(0,this.maxBlockIdx - data.onChain.historyIdx[0]) : 0 } } )
    }

    // expects privateKey in base58, returns signed in base58
    walletSign(privateKey, data) {
        const _privateKey = Buffer.from(bs.decode(privateKey)) // Buffer.from(wallet.privateKey, 'base64')
        const encoded = nacl.sign(Buffer.from(data), _privateKey)

        return encoded ? bs.encode(encoded) : false // Buffer.from(encoded).toString('base64')
    }

    // expects publicKey & signdData in base-58
    // if signedDat was signed with this wallets private key, then readable text should be present 
    // decoding with publicKey
    walletDecode(publicKey, signedData) {
        // last character is checksum, remove
        const _publicKey = Buffer.from(bs.decode(publicKey.slice(0,-1)))
        const decoded = nacl.sign.open(Buffer.from(bs.decode(signedData)), _publicKey)

        if( !decoded ) return false
        return Buffer.from(decoded).toString('utf-8')
    }
    
    // expects publicKey & signdData in base-58
    walletVerify(publicKey, signedData, verifyData) {
        const decoded = this.walletDecode(publicKey, signedData)
        return decoded == verifyData
    }
    
    merkleVerify(hash, proof, merkleRoot) {
        // loop through and compound hashes, proof setup to allow this
        for (let i = 0; i < proof.length; i++) {
            const current = bs.decode(hash)
            const sibling = bs.decode(proof[i])
            const smallFirst = Buffer.compare(current, sibling)
            // follow buildMerkleProof arbitrary choice: smaller hash first, consistent order
            hash = bs.encode( sha256Hash(smallFirst >=0 ? current + sibling : sibling + current) )
        }

        return hash === merkleRoot
    }

}
