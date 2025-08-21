
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

export default class Wallet {
    constructor( walletFile = 'data/wallet.json', TransactionHandler ) {
        this.addresses = {}
        this.snapshots = {}
        this.maxBlockIdx = 0 // used by walletBalances(), mainly debug output
        this.debugOutputLevel = 1

        // classes used
        this.TransactionHandler = TransactionHandler

        // read the wallet file
        if( walletFile ){
            const directory = path.dirname(walletFile)
            if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
            this.walletFile = path.join(directory, path.basename(walletFile));

            let jsonData = fs.existsSync(this.walletFile) ? fs.readFileSync(this.walletFile, 'utf8').trim() : '{}'
            this.addresses = JSON.parse( jsonData )
        }
    }

    // track the max block idxsetMaxBlock
    setMaxBlock(idx) {
        this.maxBlockIdx = idx
    }

    getNameOnly(name) {
        if( name.indexOf(':')>1 ) 
            name = name.split(':')[0]
        return name
    }    

    buildNameWithPublicKey(name, publicKey = '') {
        if( !publicKey && !name.includes(':') ){
            publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey
        }

        if( publicKey && !name.endsWith('$') && name !== publicKey && !name.includes(':') ) 
            name += ':' + publicKey
        return name
    }

    // for readability, we allow a more flexible address system
    // user:publicKey are sent, but we can look-up just by user name
    getUserPublicKey(name) {
        // admin-levels don't have public keys, use name
        if( !name ) 
            return { error: 'Empty name' }
        else if( typeof(name)==='object' )
            return name.publicKey || { error: 'Wallet without publicKey' }
        else if( name.endsWith('$') ) // system-accts don't need publicKey, so just return name
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

    findUsers(matchName) {
        debug( ` . . ~ [Wallet::findUsers(${matchName})] this.addresses`, this.addresses)
        const matches = Object.values(this.addresses).filter( w => 
            w.name.includes(matchName) && w.name !== this.TransactionHandler.MINT_TOKEN )
        debug( `findUsers(${matchName}) `, matches )

        return matches.map( w => w.name )
    }

    getUser(name, autoCreate = true) {
        const publicKey = this.getUserPublicKey(name)
        if( publicKey.error ) return publicKey
        
        // if no wallet create (if autoCreate, else return false)
        let wallet = this.addresses[publicKey]
        if( wallet === undefined && autoCreate){
            // undefined, create a new entry
            this.addresses[publicKey] = { created: time(), publicKey }
            wallet = this.addresses[publicKey]
            // 
            wallet.name = this.getNameOnly(name)        
            this.initToken( wallet, this.TransactionHandler.BASE_TOKEN )
            this.update(name)
            debug('dim', `  ~ [getUser] Created new user: ${name}, publicKey: ${publicKey}` )
        }

        return wallet || { error: `User ${name} didn't exist; and autoCreate(${autoCreate}) disabled. Aborting.`}
    }

    // unlike getUser that will use provided publicKey to build out a user
    // this will generate a new publicKey/privateKey for wallet transactions
    // only if the user does not already exist.
    generate(name) {
        if( !name || name.includes('$') || name.startsWith('*') || name.length === 45 ) 
            return { error: `You need to give a name for the wallet address (cannot *start* with (*); cannot have a dollar-sign($) in it)` }

        // if user exists, check if privateKey, if not, we add it, if no user, we create that user too!
        let wallet = this.getUser(name)
        if( wallet.error ) {
            // wallet doesn't exist, generate it
            debug('dim',` - No existing publicKey or privateKey for (${name}); creating public/privateKeys`)
            let { publicKey, privateKey }= Crypto.genKeyPair()
            publicKey += Crypto.keyChecksum(publicKey)  // append a checksum character
            wallet = this.getUser(name+':'+publicKey)   // now auto-generate wallet with publicKey
            this.update(name, { privateKey })           // save the private key!

        } else {
            return { error: `Name '${name}' already taken, select another to generate.`}
        }

        return wallet
    }

    // udate wallet with new data (if present) and either way write to file updated wallet
    update(name, walletData={}) {
        // if in data, preference given over that
        const publicKey = walletData.publicKey ? walletData.publicKey : this.getUserPublicKey(name)
        // tried getUserPublicKey and failed, no known key
        if( publicKey?.error ) return publicKey

        let wallet = this.addresses[publicKey]
        if( !wallet ) return { error: `For [update], name(${name}) non-existent wallet` }

        if( Object.keys(walletData).length > 0 ){
            // got a unique name, let's save it - else it becomes generic publicKey - don't let walletData change name/publicKey
            name = this.getNameOnly(name)        
            this.addresses[publicKey] = { ...wallet, ...walletData, name, publicKey }
            wallet = this.addresses[publicKey]
        }

        // update wallet file
        fs.writeFileSync(this.walletFile, JSON.stringify(this.addresses))

        return wallet
    }

    
    userSnapshots( names ){
        let snapCnt = 0
        for( const name of names ){
            const publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey

            this.snapshots[publicKey] = JSON.stringify(this.addresses[publicKey] || {})
            snapCnt++
        }
        return { error: false, snapCnt }
    }

    userRestores( names ){
        let restoreCnt = 0
        for( const name of names ){
            const publicKey = this.getUserPublicKey(name)
            if( publicKey.error ) return publicKey

            this.addresses[publicKey] = JSON.parse(this.snapshots[publicKey])
            restoreCnt++
        }
        return { error: false, restoreCnt }
    }

    balances(names = [], compact = false ) {
        const BASE_TOKEN = this.TransactionHandler.BASE_TOKEN
        let addresses = Object.values(this.addresses)
        let publicKeys = []
        if( names.length>0 ){
            publicKeys = names.map( n => this.getUserPublicKey(n) )
            addresses = addresses.filter( u => publicKeys.includes( u.publicKey ) ) // only show users
        }
        
        // add chain-depth
        // BUGBUG TODO display is for debugging ONLY 
        if( compact ){
            return publicKeys.map( publicKey => `${this.addresses[publicKey].name}: $${this.addresses[publicKey][BASE_TOKEN].tx.balance}` ).join(',')

        } else {
            debug('dim',`   = Name =${' '.repeat(14)} = TX Balance =${' '.repeat(9)} = Block Balance =${' '.repeat(2)} = Depth =  = Block History =`)
            for( const w of addresses.filter( w => w.name ).sort((a, b) =>  a.name.localeCompare(b.name)) ){
                if( w.name === this.TransactionHandler.MINT_TOKEN ) continue // ignore this global issuer account
                
                const name = w.name.length>19 ? w.name.substring(0,17)+'...' : w.name 
                for( const token of this.listTokens(w) ){
                    // console.log( `[token] (${token}) of tokens; w=`, w)
                    if( names.length!==0 && w[token]?.tx.balance>0 ){
                        let seqInfo = w.seq.tx > 0 || w.seq.onChain > 0 ? `${w.seq.tx},${w.seq.onChain}` : ''
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
        // don't pass out privateKey EVER - but all other info from the wallet is ok
        // add in depth
        return addresses.map( ({ privateKey, ...data }) =>{ return { ...data, depth: data[BASE_TOKEN].onChain.historyIdx.length > 0 ? Math.max(0,this.maxBlockIdx - data[BASE_TOKEN].onChain.historyIdx[0]) : 0 } } )
    }

    // expects privateKey in base58, returns signed in base58
    sign(name, data) {
        const wallet = this.getUser(name)
        if( wallet.error || !wallet.privateKey ) 
            return { error: `Unable to sign transaction: ${!wallet.privateKey ? `Missing privateKey for (${name})`: wallet.error}; Declining.` }

        return Crypto.sign(wallet.privateKey, data)
    }

    // expects publicKey & signdData in base-58
    // if signedDat was signed with this wallets private key, then readable text should be present 
    // decoding with publicKey
    decode(name, signedData) {
        const wallet = this.getUser(name)

        if( wallet.error || !wallet.publicKey ) 
            return { error: `Unable to sign transaction: ${!wallet.publicKey ? `Missing publicKey for (${name})`: wallet.error}; Unable to decode.` }

        // last character is checksum, remove
        return Crypto.decode(wallet.publicKey.slice(0,-1),signedData)
    }

    syncTxToChain( addresses, minerTokens = false ){
        // pass thru, so we don't need provide whoe TransactionHandler class to Wallet-using class
        this.TransactionHandler.syncTxToChain( addresses, minerTokens )        
    }
    
    // token functions
    listTokens( wallet ) {
        const tokens = Object.keys(wallet).filter( k => k.endsWith('$') )
        return tokens
    }

    initToken( wallet, token ) {
        const tokenWalletBalanceInfo = {
            onChain: {amount: 0, balance: 0, historyIdx: []},
            tx: {amount: 0, balance: 0}
        }
        wallet[token] = tokenWalletBalanceInfo
        // if base-token it's account reset, so reset seq
        if( token === this.TransactionHandler.BASE_TOKEN ) wallet.seq = {tx: 0, onChain: 0}
    }


    // main methods
    // we re-create the transactions, but keep other stuff like public/private keys shared
    resetAllTokens( addresses = Object.keys(this.addresses) ){
        if( typeof(addresses) === 'string' ) addresses = [addresses]
        if( addresses.length == 0 ) return false

        for( const publicKey of addresses ){
            // reset wallet transactions as we re-tabulate them, breaks reference points in case
            const wallet = this.addresses[publicKey]
            // this.initToken( wallet, this.TransactionHandler.BASE_TOKEN )
            for( const token of this.listTokens(wallet) )
                this.initToken[wallet,token]
        }
    }
}
