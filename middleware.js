exports.text= function (req,res,next)
{
    req.text = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk){ req.text += chunk });
    req.on('end', next);
};

exports.json= function (req,res,next)
{
    req.json = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk){ req.json += chunk });
    req.on('end', function ()
    { 
       try
       {
          req.json= JSON.parse(req.json);
          next(); 
       }
       catch (ex)
       {
          next(ex);
       }
    });
};

exports.log= function (req, res, next)
{
   console.log(req.method,req.protocol + '://' + req.get('host') + req.originalUrl);
   next();
};
