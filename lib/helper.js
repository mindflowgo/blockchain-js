
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
    return Math.round(num * 1000000000)/1000000000
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
    // if( type=='hex') console.log( `[calcHash] ${block} hash = '${hash}'`)
    return typeof(hash) === 'object' ? new Uint8Array(hash) : hash
}

export function wait(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(), time) // Check every 100ms
    })
}

export function waitReady(obj, prop1, prop2, value) {
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            if (obj[prop1][prop2] === value) {
                clearInterval(interval)
                resolve()
            }
        }, 100) // Check every 100ms
    })
}

let activeStyleCode = ''
export function debug(style, text, ...args ){
    const styleCodes = {
        reset:  "\x1b[0m",
        bold:   "\x1b[1m",
        unbold: "\x1b[22m",
        dim:    "\x1b[2m",
        inverse:"\x1b[7m",
        hide:   "\x1b[8m",
        black:  "\x1b[30m",
        red:    "\x1b[31m",
        green:  "\x1b[32m",
        yellow: "\x1b[33m",
        blue:   "\x1b[34m",
        magenta:"\x1b[35m",
        cyan:   "\x1b[36m",
        white:  "\x1b[37m"
    }

    // if args, show them, else just text. if 'style' not above, treat as normal text
    if( styleCodes[style] && !text ){
        activeStyleCode = ( style !== 'reset' ? (styleCodes[style] || '') : '' )
        console.log( styleCodes.reset + styleCodes[style] ) // turn on a styling

    } else if( style && !text && !styleCodes[style] ){
        console.log( style )
    } else if( args.length>0 ) {
        console.log( styleCodes.reset + (styleCodes[style] || style) + text + styleCodes.reset + activeStyleCode, args)
    } else {
        console.log( styleCodes.reset + (styleCodes[style] || style) + text + styleCodes.reset + activeStyleCode )
    }
}

export function urlCall({body, ...options}) {
    return new Promise((resolve,reject) => {
        const url = new URL(options.hostname)
        const hostname = url.hostname
        const port = options.port || url.port
        const method = typeof(body) === 'undefined' ? 'GET' : 'POST'
        // console.log( `<< [${options.nodeToken} >> ${options.hostname.slice(7)}] ${options.path} ${method}` )
        const req = http.request({
            method,
            headers: {
                // 'Authorization': `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
                'NodeToken': `${options.nodeToken || 'API'}`, // TODO nodeToken will some authenticated token
                'Hostname': `${url.protocol}//${hostname}:${port}`,
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
        req.on('error',()=>resolve({ error: `Unable to connect ${hostname}:${port}`, host: hostname+':'+port }));
        // for POST
        if(method === 'POST')
            req.end( JSON.stringify(body) ) // 'application/json'
        else
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
        // const remoteIP = res.getRemoteAddressAsText() // res.getProxiedRemoteAddressAsText()).toString()
        req.nodeToken = req.getHeader('nodetoken') // TODO proper auth'd node-id
        req.hostname = req.getHeader('hostname')
        req.url = req.getUrl()
        if( req.getQuery() !== '' ) req.query = Object.fromEntries(new URLSearchParams(req.getQuery()))
        
        // if node state is not online, adjust behaviour
        if( nodeState === 'ONLINE' || nodeState === 'PREPARING' ){ // || ['/blocks/hashes','/blocks','/node/announce'].includes(req.url) 
            handler(res, req)
        } else {
            debug( 'red', `>> [${req.nodeToken}]${req.url} Ignoring (in state: ${nodeState})}` )
            res.end( JSON.stringify({ error: `Currently not online: ${nodeState}` }) )
        }
            
    }
}

// includes parsing for POST functions (TODO expand middleware checking)
export function handlePOST(handler, nodeState) {
    return async (res, req) => {
        // req.forEach((k, v) => console.log( `header[${k}] = ${v}`))
        const head = { // can't pass req into async body so new object
            nodeToken: req.getHeader('nodetoken'), // TODO proper auth'd node-id
            hostname: req.getHeader('hostname'),
            url: req.getUrl() 
            }
        res.writeHeader('Content-Type', 'application/json')

        // if node state is not online, adjust behaviour
        if( nodeState === 'ONLINE' || nodeState === 'PREPARING' || ['/transactions'].includes(req.url) ){
            try {
                const body = await parseBody(res)
                const data = JSON.parse(body)
                if( data ){
                    const result = await handler(data,head)
                    res.end(JSON.stringify({ error: false, ...result }))
                } else {
                    res.end(JSON.stringify({ error: `Invalid JSON post to ${head.url}` }))
                }
            } catch (e) {
                console.error(`Error in POST ${head.url}:`, e)
                res.end(JSON.stringify({ error: head.url + ': ' + (e.message || "Internal Server Error") }))
            }
        } else {
            debug( 'red', `>> [${head.nodeToken}]${head.url} Ignoring (in state: ${nodeState})}` )
            res.end( JSON.stringify({ error: `Currently not online: ${nodeState}` }) )
        }
    }
}