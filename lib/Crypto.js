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

    // build Merkle using data aarray holding base58-hash entries
    static merkleBuild(data) {
        if (data.length === 0) return 0

        let layers = []
        layers.push(data.map(d => d.hash))

        // Step 2: Build the tree upwards
        while (layers[layers.length - 1].length > 1) {
            let currentLevel = layers[layers.length - 1]
            // If odd number of elements, repeat/duplicate last
            if (currentLevel.length % 2 === 1) 
                currentLevel.push(currentLevel[currentLevel.length - 1])

            let newLevel = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                // have a consistent way of arranging the 2 numbers, ex. smaller first else use symmetric hash
                newLevel.push( this.hashJoinTwo(currentLevel[i],currentLevel[i + 1]) )
            }

            layers.push(newLevel)
        }
        return layers
    }

    // Generate the Merkle Proof for a specific entry, passing in data-array
    static merkleProof(data, txHash) {
        const tree = this.merkleBuild(data)
        const txHashList = tree[0] 
        let index = txHashList.indexOf(txHash)
        if (index === -1)
            return { error: `Hash NOT found in block. Aborting.` }

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
            hash = this.hashJoinTwo(hash,proof[i])
        }

        return hash === merkleRoot
    }
}

export default Crypto