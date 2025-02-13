
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
    clear(){
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
    
    buildNameKey(name, publicKey) {
        if( !name.startsWith('_') && !name.includes(':') && name !== publicKey) 
        name += ':' + publicKey
        return name
    }

    // for readability, we allow a more flexible address system
    // user:publicKey are sent, but we can look-up just by user name
    getPublicKey(name) {
        // admin-levels don't have public keys, use name
        if( !name ) return { error: 'Empty name' }
        if( name.startsWith('_') )
            return name

        let publicKey = { error: 'Unknown wallet' }
        if( name.indexOf(':')>1 )
            publicKey = name.split(':')[1]
        else if( name.length == 45 )
            publicKey = name
        else if( name.length>1 ) {
            // publicKey unknown, scan 'name' fields in addressbook
            const arrayAddresses = Object.values(this.wallets)
            const wallet = arrayAddresses.filter(item => item.name === name)
            if( wallet.length === 1 && wallet[0].publicKey )
                publicKey = wallet[0].publicKey
        }

        if( publicKey.length !== 45 ) 
            return { error: `Public Key length (${publicKey.length}) wrong.`}

        if( !this.checksumPublicKey(publicKey,false) ){
            return { error: `Public Key INVALID checksum, typo?`}
        }

        return publicKey
    }

    // the transaction sequence
    getTransactionSeq(publicKey, increase = false) {
        // create if not existing
        const wallet = this.wallets[publicKey] ? this.wallets[publicKey] : this.updateWallet(publicKey)
        
        // increase in our wallet ledger
        if( increase ) wallet.seq++

        return wallet.seq
    }

    getWallet(name) {
        const publicKey = this.getPublicKey(name)
        
        if( publicKey.error ) return { error: publicKey.error, balance: 0 }
        
        // if no wallet we give create a wallet structure
        return this.wallets[publicKey] || { publicKey, seq: 0, balance: 0 }
    }

    createWallet(name) {
        if( !name || name.startsWith('_') || name.indexOf(':')>0 ) {
            console.log( `you need to give a name for the wallet (cannot *start* with _; cannot have colon in it)`)
            return
        }

        // if user exists, check if privateKey, if not, we add it, if no user, we create that user too!
        let userWallet = this.getWallet(name)
        if( userWallet.privateKey ){
            console.log( ` - User wallet & privateKey already exist, using it.`)
        } else {
            console.log( ` - Updating/creating (${name}) with new public/privateKey`)
            // Generate a new key pair
            let tryCnt = 0, publicKey = '', privateKey = ''
            do {
                const keyPair = nacl.sign.keyPair()
                publicKey = bs.encode(Buffer.from(keyPair.publicKey))
                privateKey = bs.encode(Buffer.from(keyPair.secretKey))
            } while( publicKey.length !== 44 && tryCnt++<10 )            
            publicKey += this.checksumPublicKey(publicKey) // append a checksum character
            userWallet = this.updateWallet(name, { publicKey, privateKey, seq: 0, balance: 0 })
        }
        return userWallet
    }

    updateWallet(name, walletData={}) {
        let publicKey = this.getPublicKey(name)

        if( publicKey.error && walletData.publicKey )
            publicKey = walletData.publicKey

        else if( publicKey.error ) {
            console.log( `[Wallet:update] ${publicKey.error}`)
            return publicKey
        }

        // got a unique name, let's save it - else it becomes generic publicKey
        if( name.indexOf(':')>1 )
            name = name.split(':')[0]
        else if( this.wallets[publicKey] && this.wallets[publicKey].name )
            name = this.wallets[publicKey].name

        const wallet = { seq: 0, ...this.wallets[publicKey] || {}, ...walletData, name, publicKey }

        this.wallets[publicKey] = wallet

        // write it
        fs.writeFileSync(this.ledgerFile, JSON.stringify(this.wallets))

        return wallet
    }
    
    calcHash(transactionData) {
        // copy transaction data, remove non-hashable items, hash
        const hashData = { ...transactionData }

        // these fields aren't included in security hash
        delete hashData.hash
        delete hashData.txSig
        delete hashData.txStake
        // Ethereum and some other blockchains use Keccak-256 as it has better protection against quantum computing
        // But sha256 is strong used by BTC and similar ecosystems - encode bs58 to make it shorter with alpha chars vs hex
        return bs.encode(sha256Hash(hashData)) //.digest('hex')
    }
    
    transactionSign({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}){
        const publicKey =  this.getPublicKey(src)            
        if( publicKey.error ){
            console.log( `${src} sign error: ${publicKey.error}`)
            return { error: publicKey.error }
        }

        const destPublicKey =  this.getPublicKey(dest)
        if( destPublicKey.error ){
            console.log( `${dest} error: ${destPublicKey.error}`)
            return { error: destPublicKey.error }
        }

        // append public key
        src = this.buildNameKey(src, publicKey)
        dest = this.buildNameKey(dest, destPublicKey)

        // build transaction
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )
        const newTransaction = { timestamp: time(), src, dest, amount, fee, type, seq, ...data }
        const newHash = this.calcHash(newTransaction) // hash does NOT include signature (txSig), txStake claim
        if( hash !== '' && hash !== newHash )
            return { error: `Transaction had a hash (${hash}) that did not match our calculated hash(${newHash})` }

        // sanctioned transaction signing includes:
        //   - admin-level _src
        //   - valid srcWallet.privateKey 
        //   - pre-generated txSig
        if( src.startsWith('_') ) {
            // admin-level src, does not require signature
            // txSig = '_' + hash

        } else if( txSig && publicKey ){
            // verify the sig
            if( !this.walletVerify(publicKey, txSig, newHash) ){
                console.log( ` xx Signature was INVALID, rejecting transaction.`)
                return { error: `Transaction signature was INVALID, rejecting.` }
            }

        } else {
            // at this point, no txSig, not admin-src, so we need privateKey
            const srcWallet = this.getWallet(src)

            if( srcWallet.privateKey ) {
                // wasn't signed, but we have the private key, so we assume it's from a sanctioned system, we'll sign it
                txSig = this.walletSign(srcWallet.privateKey, newHash) 
            } else {
                console.log( `Unable to create transaction. Lacking ${src} privateKey to sign, and not signed with valid txSig. Rejecting.`)
                return { error: `Unable to create transaction. Lacking ${src} privateKey to sign, and not signed with valid txSig. Rejecting.` }
            }
        }

        if( txSig ) newTransaction.txSig = txSig
        newTransaction.hash = newHash

        return newTransaction
    }

    transaction({src, dest, amount, fee = 0, type = '', seq = 0, txSig = '', hash = '', ...data}){
        // all other parameters we don't care about so leave in 'data' block (need for hash-calcs)

        let signedTransaction
        // signed ok; now check if has src has balance (if non-admin user)
        const srcWallet = this.getWallet(src)
        fee = fixRounding( Number(fee || 0) )
        amount = fixRounding( Number(amount || 0) )

        // increase sequence to src-users next expected one
        // console.log( `src(${src}) srcWallet: `, srcWallet )
        seq = this.getTransactionSeq(srcWallet.publicKey,true)

        // type must be valid
        if( !['mintIssue','miningReward','miningFees','mintAirDrop','minerDeposit','transfer'].includes(type) ){
            return { error: `Unknown transaction type(${type}). hash(${hash}). Choices(mintAirDrop; minerDeposit; transfer) Rejecting.` }
        }

        if( data.reverseAuth ){
            // if it's authorized to reverse we skip all the signing, and amount checking
            signedTransaction = { timestamp: time(), src, dest, amount, fee, type: `reversal:${type}`, seq, source: hash,  ...data }

        } else {
            // go through motion of signing transaction to see if it would pass (otherwise no point proceeding)
            signedTransaction = this.transactionSign({src, dest, amount, fee, type, seq, txSig, hash, ...data})
            if( signedTransaction.error ) return signedTransaction

            if( src !== '_' && Number(srcWallet.balance) < (amount+fee) ){ // only global issuer '_' can be negative
                console.log( `Known ${src} balance(${srcWallet.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.`)
                return { error: `Known ${src} balance(${srcWallet.balance}) less than transaction amount(${amount}+fee=${amount+fee}). Rejecting.` }
            }
            hash = signedTransaction.hash
        }

        // reflect transaction in ledger
        // ---------------------- 
        // src
        if( hash == srcWallet.hash )
            return { error: `Duplicate transaction, ${hash} already exists`}

        let balance = fixRounding( Number(srcWallet.balance || 0) - (amount+fee) )
        let result = this.updateWallet( src, { balance, amount: - (amount+fee), seq, hash })
        if( result.error ) return result

        // dest
        const destWallet = this.getWallet(dest)        
        balance = fixRounding( Number(destWallet.balance || 0) + amount )
        result = this.updateWallet( dest, { balance, amount, hash })
        if( result.error ) return result

        // MINT: redeposit fee into mint: will be credited to a miner when block minted
        if( fee !== 0 ){
            const mintWallet = this.getWallet('_mint')
            balance = fixRounding( Number(mintWallet.balance || 0) + fee )
            result = this.updateWallet( '_mint', { balance, amount: fee, hash })
            if( result.error ) return result
        }

        console.log( `  ~ transaction ${data.reverseAuth?'*REVERSED*':''} (${src.split(':')[0]}/${srcWallet.seq}${srcWallet.privateKey?'[Signed]':''}) -> (${dest.split(':')[0]||dest}) $ ${amount} `+( fee ? `fee(${fee})`  : '') + ` type(${signedTransaction.type || ''})` )
        //filter( item=>[src,dest].includes(item.name) ).
        Object.values(this.wallets).filter( item=>item.name!== '_' ).forEach( item=>{
            const name = item.name.length>19 ? item.name.substring(0,17)+'...' : item.name 
            console.log( `   - ${name}: ${' '.repeat(20-name.length)} $ ${item.balance || '0'} ${' '.repeat(20-item.balance.toString().length)}`)
            })

        return signedTransaction
    }
    
    transactionReverse({src, dest, amount, fee, ...data }){
        // TODO some sort of authority management for reverseAuth, signed by miner?
        // resubmit the transaction but reverse the fees, clear the hash, and add reverseAuth signing
        return this.transaction({src, dest, amount: -amount, fee: -fee, ...data, hash: '', reverseAuth:true })
    }

    list() {
        return this.wallets;
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