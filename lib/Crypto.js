/**************************************************************************
 * Crypto Module
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This module handles core cryptographic operations: hashing, key generation,
 * signing, and verification for the blockchain system.
 * ***********************************************************************/

import crypto from 'crypto'

// generates 32-byte ed25519 keys (more compact) than crypto library
import nacl from 'tweetnacl'
// using bs58 as its just ascii characters
import bs from 'bs58'

export class Crypto {
    // sha256 hash -- outputs binary or hex (type='hex')
    static hashRaw(data, type = '') {
        // convert data to string; return uint8 from sha256, unless string (ex. type='hex')
        data = typeof(data) === 'object' ? JSON.stringify(data) : typeof(data) === 'string' ? data : data.toString()
        const hash = crypto.createHash('sha256').update(data).digest(type)
        return typeof(hash) === 'object' ? new Uint8Array(hash) : hash
    }

    static hash(data) {
        return bs.encode(this.hashRaw(data))
    }

    // smaller hash first
    static hashJoinTwo(hashA,hashB) {
        const _hashA = bs.decode(hashA)
        const _hashB = bs.decode(hashB)
        return this.hash( Buffer.compare(_hashA, _hashB) >=0 ? _hashA + _hashB : _hashB + _hashA )
    }
    
    static genKeyPair(){
        let tryCnt = 0, publicKey = '', privateKey = ''
        // Generate a new key pair, soemtimes 43 chars, so retry creating new till 44
        do {
            const keyPair = nacl.sign.keyPair()
            publicKey = bs.encode(Buffer.from(keyPair.publicKey))
            privateKey = bs.encode(Buffer.from(keyPair.secretKey))
        } while( publicKey.length !== 44 && tryCnt++<50 )
        return { publicKey, privateKey }
    }

    // expects data as string, and privateKey base58 string
    static sign(privateKey,data) {
        const _privateKey = Buffer.from(bs.decode(privateKey)) // Buffer.from(wallet.privateKey, 'base64')
        const _data = typeof(data) === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(JSON.stringify(data))
        const signed = nacl.sign(Buffer.from(_data), _privateKey)
        return signed ? bs.encode(signed) : false // Buffer.from(encoded).toString('base64')
    }

    // base58 publicKey, base58 signedData > returns string
    static decode(publicKey,signedData) {
        // return Crypto.decrypt(wallet.publicKey.slice(0,-1),signedData)
        const _publicKey = Buffer.from(bs.decode(publicKey))
        const decoded = nacl.sign.open(Buffer.from(bs.decode(signedData)), _publicKey)

        if( !decoded ) return false
        return Buffer.from(decoded).toString('utf-8')
    }

    static keyChecksum(publicKey) {
        // only use first 44 bytes
        const bytes = bs.decode(publicKey.slice(0,44))
        const checksum = bytes.reduce((sum, byte) => (sum + byte) % 58, 0)

        return bs.encode(Buffer.from([checksum]))
    }
}

export default Crypto