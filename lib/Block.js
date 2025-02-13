import fs from 'fs'
import path from 'path'
import { brotliCompressSync, brotliDecompressSync } from 'zlib' // for file data compression
import { urlCall, sha256Hash, fixRounding, time } from './helper.js'

// Block Class ==================================================================
export default class Block {
    constructor({ index, prevHash = '', version = '', timestamp = time(), minerName = '', merkleRoot = '0', nonce = 0, powTime = 0, transactions = [] }, 
                { nodeName, compress, dataPath }) {
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
            powTime,
            transactions,
            // -------------------------
            // not part of written block; object administration only
            nodeName,
            compress,
            dataPath
        }
        Object.assign(this, defaults)

        // now check if a written block to restore for index
        const readBlockData = this.readFile()
        if( readBlockData )
            Object.assign(this, { ...this, ...readBlockData })

        // now calculate hash on block-only data
        this.hash = this.calcHash()

        // check prior block hash
        if( readBlockData && (readBlockData.hash !== this.hash  || readBlockData.index !== index) ) {
            console.log( `Warning: Error with block #${this.index}. Read hash/index is different than expected one; CRITICAL - overwriting index/hash!`)
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

    writeFile() {
        const filePath = this.filePath()
        if( fs.existsSync(filePath) ){
            console.log( ` - already exists, immutable, cannot over-writing block, CRITICAL error.`)
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
            powTime: this.powTime,
            transactions: this.transactions,
            // -------------------------
            fileCache: filePath, // entry does NOT exist in the chain, until chain reloaded (never part of the hash, local reference)
            hash: this.hash
        }
        // if uncompressed, make it pretty to view; else compress
        const writeData = this.compress ? brotliCompressSync(Buffer.from(JSON.stringify(blockData))) : JSON.stringify(blockData, null, 2)
        fs.writeFileSync(filePath, writeData)
        return true
    }

    calcHash( block = [this.index, this.prevHash, this.version, this.timestamp, this.minerName, this.merkleRoot, 
                        this.nonce, this.powTime, this.transactions] ) {
        // gather all key parts of the Block into a string that we generate sha256 on
        return sha256Hash( block, 'hex' )
    }
}