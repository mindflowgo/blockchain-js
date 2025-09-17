
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

export function fixRounding( num ) {
    // rounds 8 digits, to deal with floating-point rounding errors
    return Math.round(num * 100000000)/100000000
}

export function time() {
    return Math.round(Date.now()/1000)
}

export function isJSON(data) {
    return ['[','{'].includes(data.slice(0,1)) && [']','}'].includes(data.slice(-1)) 
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
// export function debug(style, level, text, ...args ){
//     const styleCodes = {
//         reset:  "\x1b[0m",
//         bold:   "\x1b[1m",
//         boldOff: "\x1b[22m",
//         italic: "\x1b[3m",
//         italicOff: "\x1b[23m",
//         uline: "\x1b[4m",
//         ulineOff: "\x1b[24m",
//         dim:    "\x1b[37m", //"\x1b[2m",
//         inverse:"\x1b[7m",
//         hide:   "\x1b[8m",

//         black:  "\x1b[30m", // light = append: ;1m
//         red:    "\x1b[31m",
//         green:  "\x1b[32m",
//         yellow: "\x1b[33m",
//         blue:   "\x1b[34m",
//         magenta:"\x1b[35m",
//         cyan:   "\x1b[36m",
//         white:  "\x1b[37;1m",
//         gray:   "\x1b[37m"
//     } 

//     // Reset             EscSeq = "\x1b[0m"
// 	// Italics                  = "\x1b[3m"
// 	// Underline                = "\x1b[4m"
// 	// Blink                    = "\x1b[5m"
// 	// Inverse                  = "\x1b[7m"
// 	// ItalicsOff               = "\x1b[23m"
// 	// UnderlineOff             = "\x1b[24m"
// 	// BlinkOff                 = "\x1b[25m"
// 	// InverseOff               = "\x1b[27m"
// 	// Black                    = "\x1b[30m"
// 	// DarkGray                 = "\x1b[30;1m"
// 	// Red                      = "\x1b[31m"
// 	// LightRed                 = "\x1b[31;1m"
// 	// Green                    = "\x1b[32m"
// 	// LightGreen               = "\x1b[32;1m"
// 	// Yellow                   = "\x1b[33m"
// 	// LightYellow              = "\x1b[33;1m"
// 	// Blue                     = "\x1b[34m"
// 	// LightBlue                = "\x1b[34;1m"
// 	// Magenta                  = "\x1b[35m"
// 	// LightMagenta             = "\x1b[35;1m"
// 	// Cyan                     = "\x1b[36m"
// 	// LightCyan                = "\x1b[36;1m"
// 	// Gray                     = "\x1b[37m"
// 	// White                    = "\x1b[37;1m"
// 	// ResetForeground          = "\x1b[39m"
// 	// BlackBackground          = "\x1b[40m"
// 	// RedBackground            = "\x1b[41m"
// 	// GreenBackground          = "\x1b[42m"
// 	// YellowBackground         = "\x1b[43m"
// 	// BlueBackground           = "\x1b[44m"
// 	// MagentaBackground        = "\x1b[45m"
// 	// CyanBackground           = "\x1b[46m"
// 	// GrayBackground           = "\x1b[47m"
// 	// ResetBackground          = "\x1b[49m"
// 	// Bold                     = "\x1b[1m"
// 	// BoldOff                  = "\x1b[22m"

//     // only show debug beyond debug verbosity
//     if( Number(level) >= 1 && Number(level) < Number(process.env.DEBUG) )
//         return

//     // if args, show them, else just text. if 'style' not above, treat as normal text
//     if( Number(level) < 1 )
//         // seems no level given, so assume second entry is text
//         text = level

//     if( style && !text && !styleCodes[style] ){
//         // if first is not styleCode, then simply treat as console log output
//         console.log( style )

//     } else if( styleCodes[style] && !text ){
//         // toggle some styling code
//         activeStyleCode = ( style !== 'reset' ? (styleCodes[style] || '') : '' )
//         console.log( styleCodes.reset + styleCodes[style] ) // turn on a styling

//     } else if( args.length>0 ) {
//         //  argument parameters given, so display them
//         console.log( styleCodes.reset + (styleCodes[style] || style) + text + styleCodes.reset + activeStyleCode, args)
        
//     } else {
//         console.log( styleCodes.reset + (styleCodes[style] || style) + text + styleCodes.reset + activeStyleCode )
//     }
// }

// Example usage:
// debug(3, 'this <bold>text</bold> is great <uline>stuff</uline>');
// debug(1, '<red>Error:</red> <bold>Something <italic>went</italic> wrong</> also</bold> normal text');
// debug(2, '<green>Success!</green> <italic>Operation completed</>');
export function debug(level, text, ...args) {
    // Only show debug beyond debug verbosity
    if( typeof(level) !== 'number' ){
        // no level, default to 5 = only show with max verbosity
        text = level
        level = 5
    }

    if ( level > Number(process.env.DEBUG || 0) ) return

    const styleCodes = {
        reset:      "\x1b[0m",
        bold:       "\x1b[1m", boldOff:     "\x1b[22m",
        italic:     "\x1b[3m", italicOff:   "\x1b[23m",
        uline:      "\x1b[4m", ulineOff:    "\x1b[24m",
        inverse:    "\x1b[7m", inverseOff:  "\x1b[27m",
        blink:      "\x1b[5m", blinkOff:    "\x1b[25m",
        b:          "\x1b[1m", bOff:        "\x1b[22m",
        i:          "\x1b[3m", iOff:        "\x1b[23m",
        u:          "\x1b[4m", uOff:        "\x1b[24m",
        v:          "\x1b[7m", vOff:        "\x1b[27m",
        "!":        "\x1b[5m", "!Off":      "\x1b[25m",
        red:        "\x1b[31m", // light = append: ;1m
        green:      "\x1b[32m",
        yellow:     "\x1b[33m",
        blue:       "\x1b[34m",
        magenta:    "\x1b[35m",
        cyan:       "\x1b[36m",
        white:      "\x1b[37;1m",
        gray:       "\x1b[37m",
        dim:        "\x1b[37m", //"\x1b[2m",
        hide:       "\x1b[8m",
    }
    const defaultClose = "white" // any closing without a closing uses this

    // Parse tags like <bold> ... </bold> or </>
    function parseStyledText(str) {
        const openTags = []
        return str.replace(/<(\/?)([\w|\!|_]*?)>/g, (match, closing, tag) => {
            if ( closing ){
                // shorthand </> → close last tag
                if( tag === "" ){
                    tag = openTags.pop()
                } else {
                    // Remove from open tags stack
                    const index = openTags.lastIndexOf(tag)
                    if (index > -1) openTags.splice(index, 1)            
                }
                // colortags don't have off, so back to default color
                return styleCodes[tag+'Off'] ? styleCodes[tag+'Off'] : styleCodes[defaultClose]
            }

            // opening tag, save
            if (styleCodes[tag]) {
                openTags.push(tag)
                return styleCodes[tag]
            }
            
            return match // fallback
        })
    }

    // return styled, indented
    const styled = '  '.repeat(level-1) + parseStyledText(text)

    if (args.length > 0) {
        console.log(styled, ...args)
    } else {
        console.log(styled)
    }
}

export function urlCall({ url, body, ...options }) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url)
        const hostname = urlObj.hostname
        const port = options?.port || urlObj.port
        const path = urlObj.pathname + urlObj.search
        const method = typeof(body) === 'undefined' ? 'GET' : 'POST';
        const req = http.request({
            method,
            headers: {
                // 'Authorization': `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
                'authtoken': `${options?.authtoken || 'API'}`,    // TODO authtoken will some authenticated token
                'Hostname': `${urlObj.protocol}//${hostname}:${port}`,
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Expires': '0',
                ...options.headers,
            },
            ...options,
            hostname,
            port,
            path,
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
        req.on('error',()=>resolve({ error: `Unable to connect host ${hostname}:${port}`, host: hostname+':'+port }));
        // for POST
        if(method === 'POST')
            req.end( JSON.stringify(body) ) // 'application/json'
        else
            req.end();
    })
}

export function formatURL( url ){
    if( !url || url.length<5 ){
        debug('red', `! Invalid ULR: ${url}`)
        return undefined
    }

    if( !url.startsWith('http') ) url = 'https://' + url
    if( !url.endsWith('/') ) url += '/'
    url = url.replace('https://localhost','http://localhost')

    return url
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
        req.authtoken = req.getHeader('authtoken') // TODO proper auth'd node-id
        req.hostname = req.getHeader('hostname')
        req.url = req.getUrl()
        if( req.getQuery() !== '' ) req.query = Object.fromEntries(new URLSearchParams(req.getQuery()))
        
        // if node state is not online, adjust behaviour
        if( nodeState === 'ONLINE' || nodeState === 'PREPARING' ){ // || ['/blocks/hashes','/blocks','/node/announce'].includes(req.url) 
            handler(res, req)
        } else {
            debug( 'red', `>> [${req.authtoken}]${req.url} Ignoring (in state: ${nodeState})}` )
            res.end( JSON.stringify({ error: `Currently not online: ${nodeState}` }) )
        }
            
    }
}

// includes parsing for POST functions (TODO expand middleware checking)
export function handlePOST(handler, nodeState) {
    return async (res, req) => {
        // req.forEach((k, v) => console.log( `header[${k}] = ${v}`))
        const head = { // can't pass req into async body so new object
            authtoken: req.getHeader('authtoken'), // TODO proper auth'd node-id
            hostname: req.getHeader('hostname'),
            url: req.getUrl() 
            }
        res.writeHeader('Content-Type', 'application/json')

        // if node state is not online, ignore posts except transaction ones
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
            debug( 'red', `>> [${head.authtoken}]${head.url} Ignoring (in state: ${nodeState})}` )
            res.end( JSON.stringify({ error: `Currently not online: ${nodeState}` }) )
        }
    }
}