
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

import { urlCall, sha256Hash, fixRounding, time } from './helper.js'

export default class Ledger {
    constructor(ledgerFile = '') {
        this.wallets = {}

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
            // reset wallet transactions as we re-tabulate them
            this.wallets[publicKey].balance = 0
            this.wallets[publicKey].seq = 0
            delete this.wallets[publicKey].amount
            delete this.wallets[publicKey].hash
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
        if( !publicKey ){
            publicKey = this.getPublicKey(name)
            if( publicKey.error ) return publicKey
        }

        if( !name.startsWith('_') && !name.includes(':') && name !== publicKey) 
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
            return name.publicKey || {error: 'Object without publicKey' }
        else if( name.startsWith('_') )
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
            console.log( `Public Key NOT found in local wallets` )
            return { error: `Public Key NOT found in local wallets`}
        } else if( publicKey.length !== 45 ) 
            return { error: `Public Key (${publicKey}) length (${publicKey.length}) wrong.`}

        if( !this.checksumPublicKey(publicKey,false) ){
            return { error: `Public Key INVALID checksum, typo?`}
        }

        return publicKey
    }

    getWallet(name) {
        const publicKey = this.getPublicKey(name)
        if( publicKey.error ) return { ...publicKey, balance: 0 }

        // if there's a name lets remember it
        if( name.indexOf(':')>1 ) 
            name = name.split(':')[0]

        // if no wallet create
        if( this.wallets[publicKey] === undefined )
            this.wallets[publicKey] = { name, created: time(), publicKey, seq: 0, balance: 0 }

        return this.wallets[publicKey]
    }

    createWallet(name) {
        if( !name || name.startsWith('_') || name.indexOf(':')>0 ) {
            console.log( `you need to give a name for the wallet (cannot *start* with _; cannot have colon in it)`)
            return
        }

        // if user exists, check if privateKey, if not, we add it, if no user, we create that user too!
        let userWallet = this.getWallet(name)
        if( !userWallet.privateKey ){
            console.log( ` - Updating/creating (${name}) with new public/privateKey`)
            // Generate a new key pair, soemtimes 43 chars, so retry creating new till 44
            let tryCnt = 0, publicKey = '', privateKey = ''
            do {
                const keyPair = nacl.sign.keyPair()
                publicKey = bs.encode(Buffer.from(keyPair.publicKey))
                privateKey = bs.encode(Buffer.from(keyPair.secretKey))
            } while( publicKey.length !== 44 && tryCnt++<50 )            
            publicKey += this.checksumPublicKey(publicKey) // append a checksum character
            userWallet = this.updateWallet(name, { publicKey, privateKey })
            userWallet.name = name.indexOf(':')>1 ? name.split(':')[0] : name
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
        const wallet = { ...this.wallets[publicKey] || {seq: 0, balance: 0}, ...walletData, publicKey }

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
        // - non-transaction mining metadata excluded (txStake)
        // - signature that is DONE on this hash, thus depends on it
        // - hash itself
        delete hashData.txStake
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

        // append public key
        src = this.buildTransactionName(src, publicKey)
        if( src.error ) return src
        dest = this.buildTransactionName(dest, destPublicKey)
        if( dest.error ) return dest

        // build transaction
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        const newTransaction = { timestamp: time(), src, dest, amount, fee, type, seq, ...data }
        const newHash = this.calcHash(newTransaction) // transaction-hash excludes: (txSig, hash)
        if( hash !== '' && hash !== newHash ){
            console.log( ` [transactionSign] newTransaction:`, newTransaction )
            return { error: `Transaction passed-in a hash (${hash}) that did NOT match our calculated hash(${newHash}). Rejecting.` }
        }
        // transaction signing requires:
        //   a) signing-exempt admin-level account on node (starts with _)
        //   b) supplied external valid txSig
        //   c) node having src wallet with privateKey (node generates txSig)
        if( src.startsWith('_') ) { //a)
            // admin-level src, does not require signature

        } else if( txSig && publicKey ){ // b)
            // verify the sig
            if( !this.walletVerify(publicKey, txSig, newHash) ){
                console.log( ` xx Signature was INVALID, rejecting transaction.`)
                return { error: `Transaction signature was INVALID, rejecting.` }
            }

        } else { // c)
            // at this point, no txSig, not admin-src, so we need privateKey
            const srcWallet = this.getWallet(src)

            if( srcWallet.error || !srcWallet.privateKey ) 
                return { error: `Unable to sign transaction: ${!srcWallet.privateKey ? `Missing privateKey for (${src})`: srcWallet.error}; Declining.` }

            // wasn't signed, but we have the private key, so we assume it's from a sanctioned system, we'll sign it
            txSig = this.walletSign(srcWallet.privateKey, newHash) 
        }

        if( txSig ) newTransaction.txSig = txSig
        newTransaction.hash = newHash

        return newTransaction
    }

    transaction({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}){
        // all other transaction fields don't affect us, so include directly
        let newTransaction

        // signed ok; now check if has src has balance (if non-admin user)
        const srcWallet = this.getWallet(src)
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )

        // type must be valid
        if( !['mintIssue','miningReward','miningFees','mintAirDrop','minerDeposit','transfer'].includes(type) ){
            return { error: `Unknown transaction type(${type}); hash(${hash}): choices(mintAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( data.reverseAuth ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            newTransaction = { timestamp: time(), src, dest, amount, fee, type: `reversal:${type}`, source: hash,  ...data }

        } else {
            if( src.startsWith('_') )
                seq = 0 // admin-level don't need signing, and will be attributed for in parallel on many nodes, leave seq = 0
            else if( seq > 0 && seq !== srcWallet.seq + 1 ){ // SIGNING REQUIRED (seq NEEDED!) -- TODO should queue it up and look later (ex. if out of order)
                console.log( `Wallet for (${srcWallet.name}) expects next seq(${srcWallet.seq+1}), but transaction seq(${seq}). Missing transactions? Skipping.` )
                return { error: `Wallet sequence wrong for (${srcWallet.name}) expecting next seq(${srcWallet.seq+1}), but transaction seq(${seq}). Missing transactions? Skipping.`, 
                        seq: srcWallet.seq, balance: Number(srcWallet.balance) }
            } else if( seq < 1 ) seq = srcWallet.seq + 1
                 
            // attempt to sign it, use sequence+1 for user
            newTransaction = this.transactionSign({src, dest, amount, fee, type, seq, txSig, hash, ...data})
            if( newTransaction.error ) return newTransaction

            // check ledger balance sufficient (genesis issuer '_' excluded)
            if( src !== '_' && Number(srcWallet.balance) < (amount+fee) ){
                // console.log( `Known ${src} balance(${srcWallet.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`)
                return { error: `${src} balance(${srcWallet.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`, balance: Number(srcWallet.balance) }
            }

            hash = newTransaction.hash
        }

        // update ledger balances
        // ---------------------- 
        let balance = fixRounding( Number(srcWallet.balance || 0) - (amount+fee) )
        let result = this.updateWallet( src, { balance, amount: - (amount+fee), seq, hash }) // updated seq saved
        if( result.error ) return result

        const destWallet = this.getWallet(dest)        
        balance = fixRounding( Number(destWallet.balance || 0) + amount )
        result = this.updateWallet( dest, { balance, amount, hash })
        if( result.error ) return result

        // MINT: redeposit fee into mint >> will be credited to a miner when block minted with transaction
        if( fee !== 0 ){
            const mintWallet = this.getWallet('_mint')
            balance = fixRounding( Number(mintWallet.balance || 0) + fee )
            result = this.updateWallet( '_mint', { balance, amount: fee, hash })
            if( result.error ) return result
        }

        console.log( `  ~ transaction ${data.reverseAuth?'*REVERSED*':''} (${src.split(':')[0]}${seq>0 ?'/'+seq:''}${srcWallet.privateKey?'[Signed]':''})`
                    +` -> (${dest.split(':')[0]||dest}) $ ${amount} `+( fee ? `fee(${fee})`  : '') + ` type(${newTransaction.type || ''})` )
        //filter( item=>[src,dest].includes(item.name) ).
        this.walletBalances([src,dest])

        return newTransaction
    }
    
    transactionReverse({src, dest, amount, fee, ...data }){
        // TODO some sort of authority management for reverseAuth, signed by miner?
        // resubmit the transaction but reverse the fees, clear the hash, and add reverseAuth signing
        return this.transaction({src, dest, amount: -amount, fee: -fee, ...data, hash: '', reverseAuth:true })
    }

    walletBalances(names = []) {
        let balances = {}
        let wallets = Object.values(this.wallets)
        if( names.length>0 ){
            const publicKeys = names.map( n => this.getPublicKey(n) )
            wallets = wallets.filter( i=> publicKeys.includes( i.publicKey ) )
        }
        
        wallets.sort((a, b) =>  a.name.localeCompare(b.name)).forEach( i=>{
            const name = i.name.length>19 ? i.name.substring(0,17)+'...' : i.name 
            if( !(names.length===0 && i.name === '_') ){
                const seqInfo = i.seq === 0 ? ':    ' : '/' + i.seq + ':' + ' '.repeat(3 - i.seq.toString().length)
                console.log( `   - ${name}${seqInfo}${' '.repeat(20-name.length)} $ ${i.balance || '0'} ${' '.repeat(20-i.balance.toString().length)}`)
            }
            balances[i.name] = Number(i.balance)
            })

        return balances
    }

    // expects privateKey in base58, returns signed in base58
    walletSign(privateKey, data) {
        const _privateKey = Buffer.from(bs.decode(privateKey)) // Buffer.from(wallet.privateKey, 'base64')
        const encoded = nacl.sign(Buffer.from(data), _privateKey)

        return encoded ? bs.encode(encoded) : false // Buffer.from(encoded).toString('base64')
    }

    // expects publicKey & signdData in base-58
    walletVerify(publicKey, signedData, verifyData) {
        // last character is checksum, remove
        const _publicKey = Buffer.from(bs.decode(publicKey.slice(0,-1)))
        const decoded = nacl.sign.open(Buffer.from(bs.decode(signedData)), _publicKey)

        if( !decoded ) return false
        return Buffer.from(decoded).toString('utf-8') == verifyData
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