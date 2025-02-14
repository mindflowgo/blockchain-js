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
    
    // convert block to string if not binary
    block = typeof(block) === 'object' ? JSON.stringify(block) : typeof(block) === 'string' ? block : block.toString()
    const hash = crypto.createHash('sha256').update(block).digest(type)
    return typeof(hash) === 'object' ? new Uint8Array(hash) : hash
}

export function urlCall({body, ...options}) {
    return new Promise((resolve,reject) => {
        // const req = https.request({
        const url = new URL(options.hostname)
        const hostname = url.hostname
        const port = options.port || url.port
        const method = typeof(body) === 'undefined' ? 'GET' : 'POST'
        // console.log( `body typeof(${typeof(body)}) method(${method})` )
        const req = http.request({
            method,
            headers: {
                // 'Authorization': `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
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

export function handleJSON(handler) {
// const createPostHandler = (handler) => {
    return async (res, req) => {
        res.writeHeader('Content-Type', 'application/json')
        const reqUrl = req.getUrl()
        try {
            const body = await parseBody(res)
            const data = JSON.parse(body)
            if( data ){
                const result = await handler(data, res, req)
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