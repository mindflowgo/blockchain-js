
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
import { sha256Hash, time, debug } from './helper.js'

const BLOCK_FILE_COMPRESS = false

// Block Class ==================================================================
export default class Block {
    constructor({ index, prevHash = '0', version = '', timestamp = time(), minerName = '', merkleRoot = '0', nonce = 0, powTime = 0, transactions = [] }, 
                { nodeName, compress = BLOCK_FILE_COMPRESS, dataPath, forceOverwrite }) {
        // block properties - for genesis block reset 2 fields so hash will match for all nodes
        let defaults = {
            // -- HASH CALCULATED ON --
            index,
            prevHash,
            version,
            timestamp: index>0 ? timestamp : 0,
            minerName: index>0 ? minerName || nodeName : 'genesis',
            merkleRoot,
            nonce,
            transactions,
            // -------------------------
            // not part of written block; object administration only
            powTime,
            nodeName,
            compress,
            dataPath
        }
        Object.assign(this, defaults)
        
        // now check if a written block to restore for index (if forceOverwrite, ignore it!)
        // if it's a restored read, there's a field 'fileCache' present, otherwise that is NOT present
        const readBlockData = forceOverwrite ? undefined : this.readFile()
        if( readBlockData )
            Object.assign(this, { ...this, ...readBlockData, fileCache: true })

        // now calculate hash on block-only data
        this.hash = this.calcHash()

        // check prior block hash
        if( readBlockData && (readBlockData.hash !== this.hash  || readBlockData.index !== index) ) {
            debug('red',`Warning: Error with block #${this.index}. Read hash/index is different than expected one; CRITICAL - overwriting index/hash!`)
        }
    }

    filePath(createPath = false){
        const directory = path.join(this.dataPath, this.nodeName)
        // create path if nonexistant, files are format '000001.json'
        if (createPath && !fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
        return path.join(directory, `${'0'.repeat(6-this.index.toString().length)}${this.index}.json`) + (this.compress ? '.br' : '')
    }

    deleteFile() {
        const filePath = this.filePath()
        if( fs.existsSync(filePath) )
            fs.unlinkSync(filePath);
    }

    readFile() {
        let blockData = false

        const filePath = this.filePath()        
        if( fs.existsSync(filePath) ){
            blockData = fs.readFileSync(filePath)
            if( this.compress ) blockData = brotliDecompressSync(blockData).toString()
            blockData = JSON.parse( blockData )
        }
        return blockData
    }

    writeFile(forceOverwrite = false) {
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
            powTime: this.powTime, // used by this mining-server to check on power-usage
            hash: this.hash
        }

        const writeData = this.compress ? brotliCompressSync(Buffer.from(JSON.stringify(blockData))) : JSON.stringify(blockData, null, 2)
        fs.writeFileSync(filePath, writeData)
        return true
    }

    calcHash( block ) {
        // gather all parts of the Block that are tracked by hash into a string that we generate sha256 on, defaults to above
        if( !block ) block = [this.index, this.prevHash, this.version, this.timestamp, this.minerName, this.merkleRoot, this.nonce, this.transactions]
        return sha256Hash( block, 'hex' )
    }
}