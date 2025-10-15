
/**************************************************************************
 * Simple Fully Functional Blockchain Example
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This is the BLOCK class, so all methods and data here should be 
 * ONLY related to the perspective of the Block()
 * ***********************************************************************/

import fs from 'fs'
import path from 'path'
// import { unpack, pack } from 'msgpackr' // for file data compression
import { brotliCompressSync, brotliDecompressSync } from 'zlib' // for file data compression
import { time, debug, errorWithData } from './helper.js'
import Crypto from './Crypto.js'

const BLOCK_FILE_COMPRESS = false

// Block Class ==================================================================
export default class Block {
    // instantiable part of Block()
    constructor({ index = 0, prevHash = '0', version = '', timestamp = time(), minerName, merkleRoot, nonce = 0, 
                  powTime = 0, transactions = [] }, options = {}){ 

        const { readOnly = false, forceOverwrite = false, nodeName, dataPath } = options
        
        // block properties - for genesis block reset 2 fields so hash will match for all nodes
        let defaults = {
            // -- HASH CALCULATED ON --
            index,
            prevHash,
            version,
            timestamp: index>0 ? timestamp : 0,
            minerName,
            merkleRoot: merkleRoot || '',
            nonce,
            transactions, // "data" in block
            // -- HASH INITIALLY 0 ----
            hash: 0,
            // ------------------------
            // not part of written block; object administration only
            powTime,
            // ------------------------
            // used locally for block methods but not written to block data
            options,

        }
        Object.assign(this, defaults)

        // if the data has been finalized (ie iwth merkle), let's gen hash
        if( merkleRoot )
            this.hash = this.calcHash()

        // unless forcing overwrite, data immutable: once written, read only for each block
        if( !forceOverwrite ){
            // if it's a restored read, there's a field 'fileCache' present, otherwise that is NOT present
            // if force readOnly and no file, it will die on the hash-check.
            const readBlockData = this.readData()
            if( readBlockData ){
                Object.assign(this, { ...this, ...readBlockData, fileCache: true })
                // quickly check read-block integrity (hash + index)
                if( (this.hash !== this.calcHash() || this.index !== index) ){
                    throw errorWithData( `Problem with block #${this.index}; read hash/index is different than expected; tampered block? Dropping!`, {block: readBlockData} )
                }
            } else if( readOnly ) {
                throw errorWithData( `Non-critical error: Read-only request (#${this.index}) but no block exists, failing!` )
            }
        }
    }

    getData( onlyHashableData = false ) {
        const blockData = {
            // -- HASH CALCULATED ON --
            index: this.index,
            prevHash: this.prevHash,
            version: this.version,
            timestamp: this.timestamp,
            minerName: this.minerName,
            merkleRoot: this.merkleRoot,
            nonce: this.nonce,
            transactions: this.transactions,
            // -------------------------
            hash: this.hash,
            powTime: this.powTime, // used by this mining-server to check on power-usage
        }
        if( onlyHashableData ) {
            delete blockData.hash
            delete blockData.powTime
        }
        return blockData
    }

    filePath(createPath = false){
        const directory = path.join(this.options.dataPath, this.options.nodeName)
        // create path if nonexistant, files are format '000001.json'
        if (createPath && !fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
        return path.join(directory, `${'0'.repeat(6-this.index.toString().length)}${this.index}.json`) + (BLOCK_FILE_COMPRESS ? '.br' : '')
    }

    deleteData() {
        const filePath = this.filePath()
        if( fs.existsSync(filePath) )
            fs.unlinkSync(filePath);
    }

    readData() {
        let blockData = false

        const filePath = this.filePath()        
        if( fs.existsSync(filePath) ){
            blockData = fs.readFileSync(filePath)
            if( BLOCK_FILE_COMPRESS ) blockData = brotliDecompressSync(blockData).toString()
            blockData = JSON.parse( blockData )
        }
        return blockData
    }

    writeData(forceOverwrite = false) {
        const filePath = this.filePath()
        if( !forceOverwrite && fs.existsSync(filePath) ){
            debug( 1, `<red>ERROR:</> - already exists, immutable, cannot over-writing block, CRITICAL error.`)
            return false
        }
        
        const blockData = this.getData()

        const writeData = BLOCK_FILE_COMPRESS ? brotliCompressSync(Buffer.from(JSON.stringify(blockData))) : JSON.stringify(blockData, null, 2)
        fs.writeFileSync(filePath, writeData)
        return true
    }

    calcHash( blockData ) {
        // gather all parts of the Block that are tracked by hash into a string that we generate sha256 on, defaults to above
        if( !blockData ) blockData = this.getData(true)

        return Crypto.hashRaw( blockData, 'hex' )
    }

    isHashValid(difficulty, hash) {
        const hashPrefix = '0'.repeat(difficulty)
        return hash.startsWith(hashPrefix) && !hash.startsWith(hashPrefix+'0')
    }

    // Proof-of-Work mining for the block; can limit to try for X iterations
    mine(difficulty = 1, nonce = undefined, iterations = undefined) {
        const start = time()
        let hash

        this.hash = 0
        // if giving iteration count, don't set nonce (as continuation of previous try), if ignoring, assume start at 0
        if( nonce === undefined ) 
            this.nonce = 0 
        else
            this.nonce = nonce
        
        // find a hash that starts with some number of '0's (but NO excess 0s!), as per BTC paper
        this.nonce-- // decrease nonce as it is immediately increased below (so first hash at starting nonce)
        do {
            this.nonce++
            if( iterations !== undefined ) iterations--
            hash = this.calcHash() // 'work'
            if( this.isHashValid(difficulty, hash) ) break
        } while ( iterations === undefined || iterations > 0 )

        // track time to generate PoW (in seconds), if iteration count given, we aggregate powTime
        if( iterations !== undefined ) 
            this.powTime += time() - start
        else
            this.powTime = time() - start

        // boolean: indicate if we found valid hash
        this.hash = hash
        return this.isHashValid(difficulty, this.hash)
    }
}