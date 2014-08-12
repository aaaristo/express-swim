express-swim
============

An http-based SWIM gossip protocol implementation, for expressjs apps

http://www.cs.cornell.edu/~asdas/research/dsn02-swim.pdf
http://www.cs.ucsb.edu/~ravenben/classes/papers/aodv-wmcsa99.pdf


## Getting started

Install via npm

```sh
$ npm install optimist express express-swim
```

Create your app.js

```javascript
var argv= require('optimist').argv,
    express= require('express'),
    swim= require('express-swim');

var app= express(), node= [argv.host,argv.port].join(':');

app.use('/swim',swim(node,{ verbose: true }));

app.listen(argv.port,argv.host);
console.log(node+' listening...');
```

In different terminals launch a bunch of nodes:

```sh
$ node app.js --host 127.0.0.1 --port 8001
```

```sh
$ node app.js --host 127.0.0.1 --port 8002
```

```sh
$ node app.js --host 127.0.0.1 --port 8003
```

and let them join the cluster:

```sh
$ curl -X POST -d '127.0.0.1:8001' http://127.0.0.1:8002/swim/join
$ curl -X POST -d '127.0.0.1:8001' http://127.0.0.1:8003/swim/join
```

Ok, now you have a connected cluster... Lets break it!
Try to CTRL-C some node, and see what the other nodes are doing. 
At any time you can ask for the list of active nodes to any node

```sh
$ curl http://127.0.0.1:8001/swim/nodes
```

## piggybacking

SWIM uses piggybacking of failure detection messages to disseminate
group membership info accross the cluster. And you can use the same 
strategy to propagate your app messages:


```javascript
var argv= require('optimist').argv,
    express= require('express'),
    swim= require('express-swim');

var app= express(), node= [argv.host,argv.port].join(':');

var swimApp= swim(node,{ verbose: true });

app.use('/swim',swimApp);

app.listen(argv.port,argv.host);
console.log(node+' listening...');

swimApp.swim.on('hello',function (world)
{
    console.log(world);
});

setInterval(function ()
{
    swimApp.swim.send('hello',{ world: node });
},5000);
```


