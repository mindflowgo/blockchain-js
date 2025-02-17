
/**************************************************************************
 * Simple Fully Functional Blockchain Example
 * 
 * (c) 2025 Filipe Laborde, fil@rezox.com
 * 
 * MIT License
 * 
 * This is the HELPER class, general functions used by many classes are 
 * gathered here
 * ***********************************************************************/

import https from 'https'
import http from 'http'
import crypto from 'crypto'

export function fixRounding( num ) {
    // rounds 6 digits, to deal with floating-point rounding errors
    return Math.round(num * 1000000)/1000000
}

export function time() {
    return Math.round(Date.now()/1000)
}

export function isJSON(data) {
    return ['[','{'].includes(data.slice(0,1)) && [']','}'].includes(data.slice(-1)) 
}

export function sha256Hash( block, type='' ) {
    // convert block to string; return uint8 from sha256, unless string (ex. type='hex')
    block = typeof(block) === 'object' ? JSON.stringify(block) : typeof(block) === 'string' ? block : block.toString()
    const hash = crypto.createHash('sha256').update(block).digest(type)
    return typeof(hash) === 'object' ? new Uint8Array(hash) : hash
}

export function waitReady(obj, prop, value) {
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (obj[prop] === value) {
                clearInterval(interval)
                resolve()
            }
        }, 100) // Check every 100ms
    })
}

export function urlCall({body, ...options}) {
    return new Promise((resolve,reject) => {
        const url = new URL(options.hostname)
        const hostname = url.hostname
        const port = options.port || url.port
        const method = typeof(body) === 'undefined' ? 'GET' : 'POST'
        // console.log( `body typeof(${typeof(body)}) method(${method})` )
        const req = http.request({
            method,
            headers: {
                // 'Authorization': `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
                'NodeToken': `${options.nodeToken || 'API'}`, // TODO nodeToken will some authenticated token
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Expires': '0',
                ...options.headers,
            },
            ...options,
            hostname,
            port,
        }, res => {
            const chunks = [];
            res.on('data', data => chunks.push(data))
            res.on('end', () => {
                let buffer = Buffer.concat(chunks).toString('utf-8').trim()
                if( isJSON(buffer) )
                    buffer = JSON.parse(buffer);
                resolve(buffer)
            })
        })
        req.on('error',reject);
        // for POST
        if(method === 'POST')
            req.write( JSON.stringify(body) ) // 'application/json'
            // req.write( (new URLSearchParams(body)).toString() ) // 'application/x-www-form-urlencoded'
        req.end();
    })
}

// uWebSockets Middleware --------------------------------------------------------
// for uWebSockets to read POSTed JSON
// other ideas: https://dev.to/mattkrick/replacing-express-with-uwebsockets-48ph
export async function parseBody(res) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0) // Initialize buffer properly

        res.onData((_chunk, isLast) => {
            const chunk = Buffer.from(_chunk)
            buffer = Buffer.concat([buffer, chunk]) // Concatenates safely

            if (!isLast) return

            try {
                resolve(buffer.toString('utf-8'))
            } catch (e) {
                reject(e)
            }
        })

        res.onAborted(() => {
            reject(new Error("Request aborted"))
        })
    })
}

// used by GET functions (TODO expand middleware checking)
export function handleGET(handler, nodeState) {
    return (res, req) => {
        req.nodeToken = req.getHeader('nodetoken') // TODO proper auth'd node-id

        if( nodeState !== 'ONLINE' )
            res.end( JSON.stringify({ error: `Currently not online: ${this.nodeState}` }) )
        else
            handler(res, req)
    }
}

// includes parsing for POST functions (TODO expand middleware checking)
export function handlePOST(handler, nodeState) {
// const createPostHandler = (handler) => {
    return async (res, req) => {
        req.nodeToken = req.getHeader('nodetoken') // TODO proper auth'd node-id
        // req.forEach((k, v) => console.log( `header[${k}] = ${v}`))
        const reqUrl = req.getUrl()
        res.writeHeader('Content-Type', 'application/json')

        if( nodeState !== 'ONLINE' ){
            res.end( JSON.stringify({ error: `Currently not online: ${nodeState}` }) )
            
        } else {
            try {
                const body = await parseBody(res)
                const data = JSON.parse(body)
                if( data ){
                    const result = await handler(data,req)
                    res.end(JSON.stringify({ error: false, ...result }))
                } else {
                    res.end(JSON.stringify({ error: `Invalid JSON post to ${reqUrl}` }))
                }
            } catch (e) {
                console.error(`Error in POST ${reqUrl}:`, e)
                res.end(JSON.stringify({ error: reqUrl + ': ' + (e.message || "Internal Server Error") }))
            }
        }
    }
}