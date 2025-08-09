# Blockchain JS

## Motivation
One of the best ways to truly understand something is to build it yourself. The goal of this project is to build a full-featured, although not production-ready, blockchain solution. It incorporates the key security features of modern-day blockchains and is inspired by the core ideas of Bitcoin.

The blockchain is built using JavaScript to keep the code minimal, intuitive, and self-evident.

### Implemented Blockchain Concepts
The blockchain includes the following core features:
- **Immutable blocks** with mining (Bitcoin-style proof-of-work nonce)
- **Mining rewards**
- **Transaction fees**
- **Transaction signing** (enabling wallets)
- **Transaction nonce/sequence** (similar to Ethereum/XRP, a slight improvement over Bitcoin)

No database is used; all data is stored as text/zip files in a directory.

When transactions occur, if they are new to a node, and signed properly, the node will announce it to all it's peers. It will then take the bank of the pendingTransactionss, ordered by (using SQL to model) - priority types (deposit, mint issue), then signed transactions, then the functional fees, block rewards -- each of these groups ordered by timestamp, user/seq:
```sql
ORDER BY type='minerDeposit' || type='mintIssue' DESC, txSig <> '' DESC, timestamp ASC, src ASC, seq ASC  LIMIT 10
```

### Technologies Used
- **JavaScript ES6** via Node.js
- **uWebSockets.js** for fast WebSocket/HTTP communication
- Standard encryption technologies

---

## RUNNING A NODE
```bash
node server.js debug miner0 5000
```
(will listen on localhost:5000)


Once a miner is running, you can call it directly:

### Increase mint supply
```bash
curl --data '[{"src":"_","dest":"_mint","amount":"2000000","type":"mintIssue"}]' http://localhost:5000/transactions
```

### Grant Money to Miner
```bash
curl --data '[{"src":"_mint","dest":"miner0","amount":"10000","type":"mintAirDrop"}]' http://localhost:5000/transactions && \
curl --data '[{"src":"_mint","dest":"miner1","amount":"10000","type":"mintAirDrop"}]' http://localhost:5001/transactions && \
curl --data '[{"src":"_mint","dest":"miner3","amount":"10000","type":"mintAirDrop"}]' http://localhost:5003/transactions
```

### User Deposit in Miner; then Withdraw to User
// generate the user locally first, as we need a public/private key
// note the api-url and the miner nodeName must be same (because other nodes don't know publicKey for 'miner0', except their own server)
```bash
node api.js create fil
node api.js miner-deposit miner0 fil 500 http://localhost:5000/
```

Now you have a user with money on their blockchain. You can have them send to other users:

### Create a New User
```bash
node api.js create fred
```

### Send money from your wallet to someone else (both need to have a valid wallet created)
```bash
node api.js transaction fil fred 1.369 transfer http://localhost:5000
```

If you did the minerDeposit above, your user (fil) will be known to the mining server. Your computer will send the publicKey for you and fred, and so the mining server will be able to make a public record of the transfer of money from fil to fred's account. Your computer will sign this transaction before sending it, so everyone knows that only you authorized it.


### Get Merkle Proof for a transaction
Merkle proofs allow a user to know with certainty that a node server has a transaction, as it would not able to provide the intermittent hashes without having all the transactions to calculate them. 

```bash
node api.js transaction-verify 831isZBdqs8qnSziZuVjimnoWFmMxX8HW7uszFfoUd24,6Knq7UoWrKxGcvoVmRy15E8iXCmCmTjDrmZTLb8dG8bX http://localhost:5000
```

### Checking Balances
You can check the balances on accounts with a server:
```bash
node api.js wallets fil,miner0:93Wag45TTBijDVg696N5VqjtbmMagGKbZc7W5kLoty8xZ http://localhost:5000
```

You can check the balance across multiple servers to see if it's the same:
```bash
node api.js wallets ALL http://localhost:5000,http://localhost:5001,http://localhost:5003
```

### See Queued Transactions
Mining servers will hold open transactions that aren't yet on the blockchain, that you can see. In BTC they are in whats called 'mempool', and 
aren't confirmed till written to blocks.

```bash
curl http://localhost:5003/transactions/pending
```

### TESTING ###
#### Run a few servers - 5002 does not exist, miner0 learns about other miners
```bash
node server.js debug miner0 5000 && \
node server.js debug miner1 5001 http://localhost:5000,http://localhost:5002 && \
node server.js debug miner3 5003 http://localhost:5000,http://localhost:5003
```

### Increase mint
```bash
curl --data '[{"src":"_","dest":"_mint","amount":"2000000","type":"mintIssue"}]' http://localhost:5000/transactions
```

### AirDrop to the miners
```bash
curl --data '[{"src":"$","dest":"miner0","amount":"100000","type":"mintAirDrop"}]' http://localhost:5000/transactions && \
curl --data '[{"src":"$","dest":"miner1","amount":"100000","type":"mintAirDrop"}]' http://localhost:5001/transactions && \
curl --data '[{"src":"$","dest":"miner3","amount":"100000","type":"mintAirDrop"}]' http://localhost:5003/transactions && \
curl --data '[{"src":"$","dest":"miner4","amount":"100000","type":"mintAirDrop"}]' http://localhost:5004/transactions
```

### Create local accounts
```bash
node api.js create fil
node api.js create fred
node api.js create jane
node api.js create rob
```

### Deposit money into accounts of users
```bash
node api.js miner-deposit miner0 fil 100 http://localhost:5000/ && \
node api.js miner-deposit miner1 fred 120 http://localhost:5001/ && \
node api.js miner-deposit miner3 jane 110 http://localhost:5003/ && \
node api.js miner-deposit miner4 rob 250 http://localhost:5004/ 
```

### Try overloading it
```bash
node api.js transaction fil fred 2 transfer http://localhost:5001 && \
node api.js transaction fred fil 3 transfer http://localhost:5003 && \
node api.js miner-deposit miner1 fil 201 http://localhost:5001 && \
node api.js transaction fil jane 4 transfer http://localhost:5003 && \
node api.js miner-deposit miner3 jane 214 http://localhost:5001 && \
node api.js miner-deposit miner1 rob 205 http://localhost:5001 && \
node api.js transaction fil fred 5 transfer http://localhost:5000 && \
node api.js transaction fil jane 6 transfer http://localhost:5001 && \
node api.js transaction rob jane 7 transfer http://localhost:5003 "hello friend"
```

### Check balances match across servers after transactions
```bash
node api.js wallets ALL http://localhost:5000,http://localhost:5001,http://localhost:5003,http://localhost:5004
```

### Transactions Notes
You can add a public or private note to transactions:
```bash
node api.js transaction fred jane 100 transfer http://localhost:5001 "*Thanks for the awesome phone :)"
```

If it starts with a '*', the note will be encrypted so that ONLY the destination person will be able to see it (it's encrypted for everyone else); if no *, 
then the note will be publically viewable.

### UI
If you're interested in helping build out this project or the UI for it, get in touch. 


### Try Stress-Testing 3 Nodes
```bash
# miner 0,1 online only, fresh
curl --data '[{"src":"_mint","dest":"miner0","amount":"1000","type":"mintAirDrop"}]' http://localhost:5000/transactions && \
curl --data '[{"src":"_mint","dest":"miner1","amount":"1000","type":"mintAirDrop"}]' http://localhost:5001/transactions && \

# miner 0
curl --data '[{"src":"_mint","dest":"miner0","amount":"1000","type":"mintAirDrop"}]' http://localhost:5000/transactions && \
node api.js miner-deposit miner0 fil 50 http://localhost:5000/ && \

node api.js transaction fil fred 2 transfer http://localhost:5000 && \
node api.js transaction fred jane 1.5 transfer http://localhost:5000 && \
node api.js transaction jane fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 2 transfer http://localhost:5000 && \
node api.js transaction fred jane 1.5 transfer http://localhost:5000 && \
node api.js transaction jane fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 2 transfer http://localhost:5000 && \
node api.js transaction fred jane 1.5 transfer http://localhost:5000 && \
node api.js transaction jane fil 1 transfer http://localhost:5000 

# miner 1
curl --data '[{"src":"_mint","dest":"miner1","amount":"1000","type":"mintAirDrop"}]' http://localhost:5001/transactions && \
node api.js miner-deposit miner1 rob 50 http://localhost:5001/ && \

node api.js transaction rob smith2 2 transfer http://localhost:5001 && \
node api.js transaction smith2 rob 1 transfer http://localhost:5001 && \

node api.js transaction rob smith2 2 transfer http://localhost:5001 && \
node api.js transaction smith2 rob 1 transfer http://localhost:5001 && \

node api.js transaction rob smith2 2 transfer http://localhost:5001 && \
node api.js transaction smith2 rob 1 transfer http://localhost:5001



node api.js miner-deposit miner1 fil 50 http://localhost:5001/ && \
node api.js miner-deposit miner1 fred 50 http://localhost:5001/ && \
node api.js miner-deposit miner0 jane 50 http://localhost:5000/ && \
node api.js miner-deposit miner0 rob 50 http://localhost:5000/ && \
node api.js miner-deposit miner1 smith 50 http://localhost:5001/ && \
node api.js miner-deposit miner1 smith2 50 http://localhost:5001/ && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5000 && \
node api.js transaction jane rob 1 transfer http://localhost:5001 && \
node api.js transaction rob smith2 1 transfer http://localhost:5000 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5000 && \
node api.js transaction jane rob 1 transfer http://localhost:5001 && \
node api.js transaction rob smith2 1 transfer http://localhost:5000 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

# server-independent
node api.js transaction fil fred 1 transfer http://localhost:5000 && \
node api.js transaction fred jane 1 transfer http://localhost:5000 && \
node api.js transaction jane fil 1 transfer http://localhost:5000 && \

node api.js transaction rob smith2 1 transfer http://localhost:5001 && \
node api.js transaction smith2 rob 1 transfer http://localhost:5001 




# miner 0,3 put online, given 30 seconds to sync, then run
node api.js transaction fil fred 1 transfer http://localhost:5000 && \
node api.js transaction fred jane 1 transfer http://localhost:5004 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith 1 transfer http://localhost:5001 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5000 && \
node api.js transaction jane rob 1 transfer http://localhost:5000 && \
node api.js transaction rob smith2 1 transfer http://localhost:5004 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5004 && \
node api.js transaction fred jane 1 transfer http://localhost:5001 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith2 1 transfer http://localhost:5003 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5004 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith2 1 transfer http://localhost:5000 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5000 && \
node api.js transaction fred jane 1 transfer http://localhost:5004 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith 1 transfer http://localhost:5001 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5000 && \
node api.js transaction jane rob 1 transfer http://localhost:5000 && \
node api.js transaction rob smith2 1 transfer http://localhost:5004 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5004 && \
node api.js transaction fred jane 1 transfer http://localhost:5001 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith2 1 transfer http://localhost:5003 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001 && \

node api.js transaction fil fred 1 transfer http://localhost:5001 && \
node api.js transaction fred jane 1 transfer http://localhost:5004 && \
node api.js transaction jane rob 1 transfer http://localhost:5003 && \
node api.js transaction rob smith2 1 transfer http://localhost:5000 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5001
# after 10 mins, check all sync'd:
node api.js wallets ALL http://localhost:5000,http://localhost:5001,http://localhost:5003,http://localhost:5004




node api.js transaction fred fil 3 transfer http://localhost:5001 && \


node api.js transaction fil fred 2.4 transfer http://localhost:5000 && \
node api.js transaction fred fil 3 transfer http://localhost:5001 && \
node api.js miner-deposit miner1 fil 200 http://localhost:5001 && \
node api.js transaction fil jane 4 transfer http://localhost:5003 && \
node api.js transaction jane fred 5 transfer http://localhost:5001 && \
node api.js miner-deposit miner3 jane 210 http://localhost:5003 && \
node api.js miner-deposit miner1 rob 205 http://localhost:5001 && \
node api.js transaction fil jane 6 transfer http://localhost:5003 && \
node api.js transaction rob jane 3.5 transfer http://localhost:5001 && \
node api.js transaction fil jane 6 transfer http://localhost:5004 && \
node api.js transaction rob jane 3.5 transfer http://localhost:5004 && \
node api.js transaction fil fred 2.4 transfer http://localhost:5000 && \
node api.js transaction fil fred 2 transfer http://localhost:5001 && \
node api.js transaction fred fil 3 transfer http://localhost:5003 && \
node api.js miner-deposit miner1 fil 201 http://localhost:5001 && \
node api.js transaction fil jane 4 transfer http://localhost:5003 && \
node api.js miner-deposit miner3 jane 214 http://localhost:5001 && \
node api.js miner-deposit miner1 rob 205 http://localhost:5001 && \
node api.js transaction fil fred 5 transfer http://localhost:5000 && \
node api.js transaction fil jane 6 transfer http://localhost:5001 && \
node api.js transaction rob jane 7 transfer http://localhost:5003 "hello friend"

node api.js miner-deposit miner0 smith2 250 http://localhost:5000/ && \
node api.js transaction smith2 jane 3.5 transfer http://localhost:5000

# miner 3,4 offline
node api.js transaction fred jane 1 transfer http://localhost:5001 && \
node api.js transaction jane rob 1 transfer http://localhost:5000 && \
node api.js transaction rob smith2 1 transfer http://localhost:5001 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 1 transfer http://localhost:5000 && \
node api.js transaction fred jane 1 transfer http://localhost:5001 && \
node api.js transaction jane rob 1 transfer http://localhost:5001 && \
node api.js transaction rob smith2 1 transfer http://localhost:5001 && \
node api.js transaction smith2 fil 1 transfer http://localhost:5000 && \

node api.js transaction fil fred 1 transfer http://localhost:5000 && \
node api.js transaction fred jane 1 transfer http://localhost:5001 && \
node api.js transaction jane rob 1 transfer http://localhost:5001 && \
node api.js transaction rob smith2 1 transfer http://localhost:5001 &
```