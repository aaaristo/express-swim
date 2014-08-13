var _= require('underscore'),
    mw= require('./middleware'),
    ut= require('./util'),
    async= require('async'),
    request= require('request'),
    express= require('express'),
    EventEmitter= require('events').EventEmitter;

// @see http://www.cs.cornell.edu/~asdas/research/dsn02-swim.pdf
        http://www.cs.ucsb.edu/~ravenben/classes/papers/aodv-wmcsa99.pdf

module.exports= function (localNode,opts)
{
    opts= _.defaults(opts || {},{ base: '/swim', 
                                  verbose: false,
                                  period_length: 3000,
                                  ping_timeout: 1000,
                                  failing_timeout: 9000,
                                  message_ttl: 10000,
                                  pingreq_nodes: 2,
                                  tune_gossip: 2,
                                  gossip_messages: 10 });

    var app= express(),
        swim= new EventEmitter(),
        T1= opts.period_length,                  // period length
        PING_TIMEOUT= opts.ping_timeout,         // timeout of a ping request
        FAILING_TIMEOUT= opts.failing_timeout,   // timeout of a suspected state before failing a node
        MESSAGE_TTL= opts.message_ttl,           // the time a message should be kept in the message queue
        k= opts.pingreq_nodes,                   // number of random nodes to select for a ping-req
        lambda= opts.tune_gossip,                // tune maximum message retransmission (keep it "small")
        MAX_MESSAGES= opts.gossip_messages;      // max piggybacked messages per request

    if (PING_TIMEOUT*3>T1) throw('quote: "which is chosen smaller than the protocol period...'+
                                 'Note that the protocol period has to be at least three times'+
                                 ' the round-trip estimate"');

    // todo:
    // adapt ping_timeout avg(response time)

    var periodSeq= 0,
        incSeq= 0,
        messageSeq= 0,
        membershipUpdates= [],
        servers= (function(servers){ servers[localNode]= { string: localNode, inc: 0 }; return servers; })({}),
        join= function (node)
        {
            group.join({ string: node, inc: 0 });
            sendMessage('join',localNode);
        },
        group= {
           join: function (server)
           {
              swim.emit('join',server);
              delete servers[server.string];
              servers[server.string]= server;
           },
           leave: function (string)
           {
              swim.emit('leave',servers[string]);
              delete servers[string];
           },
           suspect: function (string)
           {
              servers[string].suspect= true;
              swim.emit('suspect',servers[string]);
           },
           fail: function (string)
           {
              servers[string].failed= true;
              swim.emit('fail',servers[string]);
           },
           alive: function (string)
           {
              servers[string].suspected= servers[string].failed= false;
              swim.emit('alive',servers[string]);
           },
           inc: function (string)
           {
              return (servers[string]||{}).inc;
           },
           find: function (string)
           {
              return servers[string];
           },
           nodes: function ()
           {
              return _.pluck(_.filter(_.values(servers),function (s) { return !s.failed; }),'string');
           }
        },
        piggyback= function (seq,target)
        {
           var max= Math.round(Math.log(group.nodes().length)*lambda),
               messages= _.filter(membershipUpdates,function (upd)
                        { 
                            return upd.message.source!=target
                                && upd.counter<max;
                        });

           messages= _.sortBy(messages,function (u) // give precedence to cluster messages
                                       { 
                                           if (u.message.content.emit)
                                             return u.counter+max;
                                           else
                                             return u.counter;
                                       })
                      .slice(0,MAX_MESSAGES);

           messages.forEach(function (upd)
           {
               ++upd.counter;

               if (upd.counter>=max)
                 upd.rmTimeout= setTimeout(function ()
                 {
                    ut.rm(membershipUpdates,upd);
                 },MESSAGE_TTL);
           });

           messages= _.pluck(messages,'message');

           return { seq: seq, sender: localNode, messages: messages };
        },
        processMessages= function (ack)
        {
           if (!ack) return;

           if (ack.messages)
           ack.messages.forEach(function (message)
           {
              if (message.source==localNode) return; // ignore my messages

              if (_.filter(membershipUpdates,
                    function (upd) { return upd.message.source==message.source
                                          &&upd.message.id==message.id }).length)
                return; // ignore known messages

              if (opts.verbose) console.log('swim','receive',message);

              if (message.content.emit!==undefined)
                try
                {
                    swim.emit(message.content.type,message.content.emit);
                }
                catch (ex)
                {
                   console.log('swim','emit error',ex,ex.stack);
                }
              else 
                receive[message.content.type](message.content.subject,message.content.inc);

              membershipUpdates.unshift({ message: message, counter: 0 });
           });

           return ack;
        },
        rnodes= function (n,suspect)
        {
           var nodes= {},
               others= _.without(group.nodes(),localNode,suspect);

           if (others.length<=n)
             return others;
           else
           while (_.keys(nodes).length < n)
           {
              var rnode= others[_.random(0,others.length-1)];
              nodes[rnode]= true;
           }

           return _.keys(nodes);
        },
        ping= function (node,seq,cb)
        {
               request.post({ timeout: PING_TIMEOUT,
                                  uri: 'http://'+node+opts.base+'/ping/'+seq,
                                 body: JSON.stringify(piggyback(seq,node)) },
               function (err, res, body)
               {
                   if (err)
                     cb(err);
                   else
                   if (res.statusCode!=200)
                     cb({ code: res.statusCode, message: processMessages(ut.json(body)) });
                   else
                     cb(null,processMessages(ut.json(body)));
               });
        },
        pingReq= function (node,target,seq,cb)
        {
               request.post({ timeout: PING_TIMEOUT,
                                  uri: 'http://'+node+opts.base+'/ping-req/'+target+'/'+seq,
                                 body: JSON.stringify(piggyback(seq,node)) },
               function (err, res, body)
               {
                   if (err)
                     cb(err);
                   else
                   if (res.statusCode!=200)
                     cb({ code: 200, message: res.statusCode < 300 ? processMessages(ut.json(body)) : body });
                   else
                     cb(null,processMessages(ut.json(body)));
               });
        },
        enqueueMessage= function (m)
        {
               var upd={ message: { source: localNode, id: messageSeq++, content: m }, counter: 0 };

               membershipUpdates.unshift(upd);

               if (opts.verbose) console.log('swim','send',upd.message);
        },
        sendMessage= function (type,subject)
        {
               var server= group.find(subject);

               if (subject!=localNode&&!server) return;

               enqueueMessage({ type: type, subject: subject,
                                 inc: subject==localNode ? incSeq++ : server.inc });
        },
        receive= {
            join: function (subject,inc)
            {
                group.join({ string: subject, inc: inc });
                sendMessage('alive',localNode);
            },
            leave: function (subject,inc)
            {
                if (inc>=ring.inc(subject));
                  group.leave(subject);
            },
            alive: function (subject,inc)
            {
                var server= group.find(subject);

                if (server)
                {
                    if (inc>server.inc)
                    {
                      server.inc= inc;
                      server.suspected= clearTimeout(server.suspected);
                    }
                    else
                      group.alive(subject);
                }
                else
                  group.join({ string: subject, inc: inc });
            },
            fail: function (subject,inc) // (confirm)
            {
                if (localNode==subject)
                  sendMessage('alive',localNode);
                else
                  group.fail(subject);
            },
            suspect: function (subject,inc)
            {
                if (localNode==subject)
                {
                    if (incSeq<inc) incSeq= inc; // if a node rejoin a cluster the members may have an higher inc
                                                 // for this node

                    sendMessage('alive',localNode);
                }
                else
                {
                    var server= group.find(subject);

                    if (!server||server.failed) return;

                    if (server.suspected)
                    {
                       if (inc>server.inc)
                       {
                           clearTimeout(server.suspected);
                           server.suspected= setTimeout(function ()
                           {
                               group.fail(subject);
                               sendMessage('fail',subject);  
                           },FAILING_TIMEOUT);
                       }
                    }
                    else  
                    if (inc>=server.inc)
                      server.suspected= setTimeout(function ()
                      {
                          group.fail(subject);
                          sendMessage('fail',subject);  
                      },FAILING_TIMEOUT);
                }
            } 
        },
        pingStack= [],
        periodInterval= setInterval(function ()
        {
           periodSeq++;

           var Mj= pingStack.pop();

           if (!Mj)
             Mj= (pingStack= _.shuffle(_.without(group.nodes(),localNode))).pop();

           if (opts.verbose) console.log('swim','period',periodSeq,Mj);

           if (!Mj) return; // disabled we need more nodes on the cluster

           ping(Mj,periodSeq,function (err, ack)
           {
              if (err)
              {
                 var Mr= rnodes(k,Mj), errors= [];

                 async.forEach(Mr,
                 function (node,done)
                 {
                    pingReq(node,Mj,periodSeq,function (err, ack)
                    {
                       if (err)
                         errors.push({ node: node, err: err });
                 
                       done(ack);
                    });
                 },
                 function (ack)
                 {
                    if (!ack)
                    {
                      receive.suspect(Mj,group.inc(Mj));
                      sendMessage('suspect',Mj);
                    }
                 }); 
              }
              else
                 if (opts.verbose) console.log('swim','ping','OK',Mj,ack);
           });
        },T1);

    app.post('/ping/:seq', mw.json, function (req, res)
    {
        processMessages(req.json);

        res.send(piggyback(req.params.seq,req.json.sender));
    });

    app.post('/ping-req/:target/:seq', mw.json, function (req, res)
    {
        processMessages(req.json);

        ping(req.params.target,req.params.seq,function (err, ack)
        {
            if (err)
              res.status(504).send(piggyback(req.params.seq,req.json.sender));
            else
            {
              processMessages(ack);
              res.send(piggyback(ack.seq,req.json.sender));
            }
        });
    });

    // call on the joining node
    app.post('/join', mw.text, function (req, res)
    {
        join(req.text);
        res.end();
    });

    // call on the leaving node
    app.delete('/leave', function (req, res)
    {
        sendMessage('leave',localNode);
        res.end();
    });

    app.get('/nodes', function (req, res)
    {
        res.send(group.nodes());
    });

    swim.send= function (event,message)
    {
       enqueueMessage({ type: event, emit: message });
       swim.emit(event,message);
    };

    swim.join= join;

    app.swim= swim;

    return app;
};
