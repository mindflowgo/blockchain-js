
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
import { time, debug } from './helper.js'
import Miner from './Miner.js'
import TransactionHandler from './TransactionHandler.js'
import Crypto from './Crypto.js'

const BLOCK_FILE_COMPRESS = false

// Block Class ==================================================================
export default class Block {
    // build genesis block for the setup
    static buildGenesis(supply, token) {
        const genesisTransactions = TransactionHandler.buildGenesisTransactions(supply, token)
        // block structure for block #0
        const block = { index: 0, version: '1.0', timestamp: 0, minerName: 'genesis', transactions: genesisTransactions }
        block.hash = Crypto.hashRaw( block, 'hex' )
        return block
    }
    
    // instantiable part of Block()
    constructor({ index, prevHash = '0', version = '', timestamp = time(), minerName = Miner.nodeName, merkleRoot = '0', nonce = 0, powTime = 0, transactions = [] }, 
                { readOnly = false, forceOverwrite = false }) {
        // block properties - for genesis block reset 2 fields so hash will match for all nodes
        let defaults = {
            // -- HASH CALCULATED ON --
            index,
            prevHash,
            version,
            timestamp: index>0 ? timestamp : 0,
            minerName,
            merkleRoot,
            nonce,
            transactions, // "data" in block
            // -- HASH INITIALLY 0 ----
            hash: 0,
            // ------------------------
            // not part of written block; object administration only
            powTime,
        }
        Object.assign(this, defaults)

        if( forceOverwrite ){
            // overwrite so don't read any potential prior data -- rather just tabulate hash now ...
            this.hash = this.calcHash()

        } else {
            // if it's a restored read, there's a field 'fileCache' present, otherwise that is NOT present
            // if force readOnly and no file, it will die on the hash-check.
            const readBlockData = this.readData()
            if( readBlockData ){
                Object.assign(this, { ...this, ...readBlockData, fileCache: true })

                // quickly check read-block integrity (hash + index)
                if( (this.hash !== this.calcHash() || this.index !== index) )
                    return { error: `Problem with block #${this.index}; read hash/index is different than expected; tampered block? Dropping!`, block: readBlockData }
            } else if( readOnly ) {
                return { error: `Read-only request (#${this.index}) but no block exists, aborting!` }
            }
        }
    }

    filePath(createPath = false){
        const directory = path.join(Miner.dataPath, Miner.nodeName)
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
            debug('red',` - already exists, immutable, cannot over-writing block, CRITICAL error.`)
            return false
        }

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

        const writeData = BLOCK_FILE_COMPRESS ? brotliCompressSync(Buffer.from(JSON.stringify(blockData))) : JSON.stringify(blockData, null, 2)
        fs.writeFileSync(filePath, writeData)
        return true
    }

    calcHash( block ) {
        // gather all parts of the Block that are tracked by hash into a string that we generate sha256 on, defaults to above
        if( !block ) 
            block = [ this.index, this.prevHash, this.version, this.timestamp, this.minerName, this.merkleRoot, this.nonce, this.transactions ]
        return Crypto.hashRaw( block, 'hex' )
    }

    isHashValid(difficulty, hash = this.hash) {
        const hashPrefix = '0'.repeat(difficulty)
        return hash.startsWith(hashPrefix) && !hash.startsWith(`${hashPrefix}0`) && hash === this.hash
    }

    mine(difficulty = 1, iterations = undefined) {
        const start = time()
        let hash

        this.hash = 0
        // if giving iteration count, don't set nonce, if ignoring, assume start at 0
        if( iterations === undefined ) this.nonce = 0 
        
        // find a hash that starts with some number of '0's (but NO excess 0s!), as per BTC paper
        const hashPrefix = '0'.repeat(difficulty)
        this.nonce-- // decrease nonce as it is immediately increased below (so first hash at starting nonce)
        do {
            this.nonce++
            if( iterations > 0 ) iterations--
            hash = this.calcHash()
        } while (!hash.startsWith(hashPrefix) || hash.startsWith(`${hashPrefix}0`) || iterations !== 0 )

        // track time to generate PoW (in seconds), if iteration count given, we aggregate powTime
        if( iterations !== undefined ) 
            this.powTime += time() - start
        else
            this.powTime = time() - start

        //    hash is valid if these:
        if( this.isHashValid(difficulty,hash) ){
            this.hash = hash
            return true
        }  else {
            return false
        }
    }
}