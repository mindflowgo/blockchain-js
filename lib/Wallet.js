
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
import { time, debug } from './helper.js'

import Crypto from './Crypto.js'
import TransactionHandler from './TransactionHandler.js'

// structure for each token tracking in each wallet
const tokenWalletBalanceInfo = {
    onChain: {seq: 0, amount: 0, balance: 0, historyIdx: []},
    tx: {seq: 0, amount: 0, balance: 0}
}

export default class Wallets {
    static {
        this.addresses = {}
        this.snapshots = {}
        this.maxBlockIdx = 0 // used by walletBalances(), mainly debug output
        this.debugOutputLevel = 1
        this.walletFile = ''
    }
    
    static load(walletFile = 'data/wallet.json') {
        // read the wallet file
        if( walletFile ){
            const directory = path.dirname(walletFile)
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
            this.walletFile = path.join(directory, path.basename(walletFile));

            let jsonData = fs.existsSync(this.walletFile) ? fs.readFileSync(this.walletFile, 'utf8').trim() : '{}'
            this.addresses = JSON.parse( jsonData )
        }
    }

    // helper methods
    static getWalletTokens( wallet ) {
        const tokens = Object.keys(wallet).filter( k => k.indexOf('$')===0 )
        return tokens
    }

    static resetToken( wallet, token ) {
        const tokenWalletBalanceInfo = {
            onChain: {seq: 0, amount: 0, balance: 0, historyIdx: []},
            tx: {seq: 0, amount: 0, balance: 0}
        }
        wallet[token] = tokenWalletBalanceInfo
    }


    // main methods
    // we re-create the transactions, but keep other stuff like public/private keys shared
    static resetAllTokens( addresses = Object.keys(this.addresses) ){
        for( const publicKey of addresses ){
            // reset wallet transactions as we re-tabulate them, breaks reference points in case
            const wallet = this.addresses[publicKey]

            // clear any transaction chain tracking
            for( const token of this.getWalletTokens(wallet) )
                this.resetToken[wallet,token]
        }
    }

    // track the max block idxsetMaxBlock
    static setMaxBlock(idx) {
        this.maxBlockIdx = idx
    }

    

    static buildNameWithPublicKey(name, publicKey = '') {
        if( !publicKey && !name.includes(':') ){
            publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey
        }

        if( publicKey && !name.startsWith('_') && name !== publicKey && !name.includes(':') ) 
            name += ':' + publicKey
        return name
    }

    // for readability, we allow a more flexible address system
    // user:publicKey are sent, but we can look-up just by user name
    static getUserPublicKey(name) {
        // admin-levels don't have public keys, use name
        if( !name ) 
            return { error: 'Empty name' }
        else if( typeof(name)==='object' )
            return name.publicKey || { error: 'Wallet without publicKey' }
        else if( name.startsWith('$') ) // admins don't need publicKey, so just return name
            return name

        let publicKey = ''
        if( name.indexOf(':')>1 )
            publicKey = name.split(':')[1]
        else if( name.length == 45 )
            publicKey = name
        else if( name.length>1 ) {
            // publicKey unknown, scan 'name' fields in addressbook
            const arrayAddresses = Object.values(this.addresses)
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

        if( Crypto.keyChecksum(publicKey) !== publicKey.slice(-1) ){ // last digit is the checksum digit
            return { error: `Public Key for ${name} INVALID checksum, typo?`}
        }

        return publicKey
    }

    static getUser(name, autoCreate = true) {
        const publicKey = this.getUserPublicKey(name)
        if( publicKey.error ) return publicKey // { ...publicKey }
        
        // if no wallet create (if autoCreate, else return false)
        if( this.addresses[publicKey] === undefined && autoCreate){
            // if name/publicKey given, let's remember name part too
            if( name.indexOf(':')>1 ) 
                name = name.split(':')[0]

            this.addresses[publicKey] = { name, created: time(), publicKey }
            this.resetToken( this.addresses[publicKey], TransactionHandler.baseToken )
            console.log( `created user (name: ${name}, publicKey(${publicKey}))`, this.addresses[publicKey] )
        }

        return this.addresses[publicKey] || false
    }

    // unlike getUser that will use provided publicKey to build out a user
    // this will generate a new publicKey/privateKey for wallet transactions
    // only if the user does not already exist.
    static generate(name) {
        if( !name || name.startsWith('$') || name.indexOf(':')>0 || name.length === 45 ) 
            return { error: `You need to give a name for the wallet address (cannot *start* with ($); cannot have a colon(:) in it)` }

        // if user exists, check if privateKey, if not, we add it, if no user, we create that user too!
        let wallet = this.getUser(name)
        if( wallet.error ){
            debug('dim',` - No existing publicKey or privateKey for (${name}); creating public/privateKeys`)
            let { publicKey, privateKey }= Crypto.genKeyPair()
            publicKey += Crypto.keyChecksum(publicKey) // append a checksum character

            const walletData = { name, publicKey, privateKey }
            this.resetToken( walletData, TransactionHandler.baseToken )
            wallet = this.update(name, walletData)
        }

        return wallet
    }

    static update(name, walletData={}) {
        let publicKey = this.getUserPublicKey(name)
        // public key not in name - if also not in passed-in data, then we need to exit (need it!)
        if( publicKey.error && !walletData.publicKey )
            return publicKey

        if( publicKey.error && walletData.publicKey ){
            publicKey = walletData.publicKey
            this.addresses[publicKey] = {}
        }

        // upon creation need seq/balance; and of course publicKey cannot be changed
        // spreads overwrite sub-objects, so we rebuild tx & onChain first
        const tokenBalance = {}
        const tokens = Object.keys(walletData).filter(k => k.substring(0,1) === '$')
        for( const token of tokens ){
            this.resetToken( tokenBalance, token )
            tokenBalance[token].tx = { ...tokenBalance[token].tx, ...this.addresses[publicKey][token]?.tx, ...walletData[token]?.tx }
            tokenBalance[token].tx = { ...tokenBalance[token].onChain, ...this.addresses[publicKey][token]?.onChain, ...walletData[token]?.onChain }
        }

        const wallet = { ...this.addresses[publicKey], ...walletData, ...tokenBalance, publicKey }

        // got a unique name, let's save it - else it becomes generic publicKey
        if( name.indexOf(':')>1 )
            wallet.name = name.split(':')[0]
        
        this.addresses[publicKey] = wallet
        
        console.log( ` [wallet::udate] addresses[${publicKey}] updated, all addresses: `, JSON.stringify(this.addresses))

        // update ledger file
        fs.writeFileSync(this.walletFile, JSON.stringify(this.addresses))

        return wallet
    }

    
    static userSnapshots( names ){
        let snapCnt = 0
        for( const name of names ){
            const publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey

            this.snapshots[publicKey] = JSON.stringify(this.addresses[publicKey] || {})
            snapCnt++
        }
        return { error: false, snapCnt }
    }

    static userRestores( names ){
        let restoreCnt = 0
        for( const name of names ){
            const publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey

            this.addresses[publicKey] = JSON.parse(this.snapshots[publicKey])
            restoreCnt++
        }
        return { error: false, restoreCnt }
    }

    static balances(names = [], compact = false ) {
        let addresses = Object.values(this.addresses)
        let publicKeys = []
        if( names.length>0 ){
            publicKeys = names.map( n => this.getUserPublicKey(n) )
            addresses = addresses.filter( u => publicKeys.includes( u.publicKey ) ) // only show users
        }
        
        // add chain-depth
        // BUGBUG TODO display is for debugging ONLY 
        if( compact ){
            return publicKeys.map( publicKey => `${this.addresses[publicKey].name}: $${this.addresses[publicKey].$.tx.balance}` ).join(',')

        } else {
            debug('dim',`   = Name =${' '.repeat(14)} = TX Balance =${' '.repeat(9)} = Block Balance =${' '.repeat(2)} = Depth =  = Block History =`)
            for( const w of addresses.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)) ){
                if( w.name === '$_' ) continue // ignore this global issuer account
                
                const name = w.name.length>19 ? w.name.substring(0,17)+'...' : w.name 
                // const tokens = this.getWalletTokens(w) // Object.keys(w).filter( k => k.substring(0,1) === '$' )
                for( const token of this.getWalletTokens(w) ){
                    // console.log( `[token] (${token}) of tokens; w=`, w)
                    if( names.length!==0 && w[token]?.tx.balance>0 ){
                        let seqInfo = w[token].tx?.seq > 0 || w[token].onChain?.seq > 0 ? `${w[token].tx.seq},${w[token].onChain.seq}` : ''
                        seqInfo = !seqInfo ? ':' : '/' + seqInfo + ':'
                        const onChainBal = (w[token].tx.balance === w[token].onChain.balance ? '"' : w[token].onChain.balance) || '0'
                        const onChainDepth = w[token].onChain.historyIdx.length > 0 ? Math.max(0,this.maxBlockIdx - w[token].onChain.historyIdx[0]) : 0
                        debug('dim',`   - ${name}${seqInfo}${' '.repeat(20-(token.length+seqInfo.length+name.length))} $ ${w[token].tx.balance || '0'} `
                                +`${' '.repeat(20-(w[token].tx.balance||'0').toString().length)} $ ${onChainBal} `
                                +`${' '.repeat(22-(onChainBal.toString().length+onChainDepth.toString().length))} ${onChainDepth}`
                                +`       ${w[token].onChain.historyIdx || '-'}`)
                    }
                }
            }
        }
        console.log( ` now returning ....`)
        // don't pass out privateKey EVER - but all other info from the wallet is ok
        // add in depth
        return addresses.map( ({ privateKey, ...data }) =>{ return { ...data, depth: data.$.onChain.historyIdx.length > 0 ? Math.max(0,this.maxBlockIdx - data.$.onChain.historyIdx[0]) : 0 } } )
    }

    // expects privateKey in base58, returns signed in base58
    static sign(name, data) {
        const wallet = this.getUser(name)
        if( wallet.error || !wallet.privateKey ) 
            return { error: `Unable to sign transaction: ${!wallet.privateKey ? `Missing privateKey for (${name})`: wallet.error}; Declining.` }

        return Crypto.sign(wallet.privateKey, data)
    }

    // expects publicKey & signdData in base-58
    // if signedDat was signed with this wallets private key, then readable text should be present 
    // decoding with publicKey
    static decode(name, signedData) {
        const wallet = this.getUser(name)

        if( wallet.error || !wallet.publicKey ) 
            return { error: `Unable to sign transaction: ${!wallet.publicKey ? `Missing publicKey for (${name})`: wallet.error}; Unable to decode.` }

        // last character is checksum, remove
        return Crypto.decrypt(wallet.publicKey.slice(0,-1),signedData)
    }
}
