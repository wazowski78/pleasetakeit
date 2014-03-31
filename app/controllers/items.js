'use strict';

/**
 * Module dependencies.
 */
var mongoose = require('mongoose'),
    Item = mongoose.model('Item'),
    User = mongoose.model('User'),
    _ = require('lodash'),
    Q = require('q'),
    request = require('request'),
    fs = require('fs'),
    AWS = require('aws-sdk'),
    mailer = require('../lib/mail');

//loading access S3 access keys
AWS.config.loadFromPath(__dirname + '/aws.json')

/**
 * Find item by id
 */
exports.item = function(req, res, next, id) {
    Item.load(id, function(err, item) {
        if (err) return next(err);
        if (!item) return next(new Error('Failed to load item ' + id));
        req.item = item;
        next();
    });
};

/**
 * Create an item
 */
exports.create = function(req, res) {
    var item = new Item(req.body);
    //create endTime
    var timeFinish = Date.now() + 1000*3600*item.duration;
    console.log("This is time finish " + timeFinish);

    item.endTime = new Date(timeFinish);

    console.log("this is the endtime: ",item.endTime);

    // console.log("this is body", req.body);
    item.owned_by = req.user;
    // console.log("the req.file is ",req.image)

    //make sure form's input field is called "image"
    var file = req.files.picture;
    var filePath = file.path;

    //upload file to s3
    fs.readFile(filePath, function(err, data) {
        if (err) { throw err; }

        var s3 = new AWS.S3({ params: {Bucket: 'PleaseTakeIt', Key: file.name }});
        s3.putObject({
            Body: data
        }, function() {
            console.log('UPLOADED');
        });
    });
    //Set file path to URL in ItemSchema (baseURL+file.name)
    item.picture = "http://s3.amazonaws.com/PleaseTakeIt/" + file.name;

    //1) Change location information into appropriate string to send to GoogleMaps API
    var itemLocation = item.address.split(" ").join("+");
    var requestString = "https://maps.googleapis.com/maps/api/geocode/json?address=" + itemLocation + "&sensor=false";

    //2) set function to call geocoding API (translates to lat/long);
    var geoCodeRequest = function(url) {
        var deferred = Q.defer();
        request.get(url, function(err, response, data) {
          if (!err) {
            var googleResponse = JSON.parse(data);
            deferred.resolve(googleResponse);
          }
          else {
            deferred.reject("There was an error! Status code: " + data.status + error);
          }
        });
        return deferred.promise;
    };

    //3) Take response and parse it for latlng information
    geoCodeRequest(requestString).then(function(data){
        console.log("are we getting here?");
        var latitude = data.results[0].geometry.location.lat;
        var longitude = data.results[0].geometry.location.lng;

        item.lnglat = [longitude, latitude];
        item.save(function(err) {
            if (err) {
                return res.send('users/signup', {
                    errors: err.errors,
                    item: item
                });
            } else {
                res.send(JSON.stringify(item));
                console.log(item)
            }
        });

    })
};

// Test
/**
 * Update an item
 */
exports.update = function(req, res) {
    var updatedItem = req.body;
    // console.log("this is the item coming from the front", updatedItem);
    Item.findOne({_id: updatedItem._id}, function (err, foundItem){
        foundItem = _.extend(foundItem, updatedItem);
        foundItem.save(function(err) {
            if (err) {
                return res.send('users/signup', {
                    errors: err.errors,
                });
            } else {
                res.jsonp(foundItem);
            }
        });
    })
};

/**
 * Delete an item
 */
exports.destroy = function(req, res) {
    var item = req.wantItem;

    item.remove(function(err) {
        if (err) {
            return res.send('users/signup', {
                errors: err.errors,
                item: item
            });
        } else {
            res.jsonp(item);
        }
    });
};

/**
 * Show an item
 */
exports.show = function(req, res) {
    res.jsonp(req.item);
};

//Find items by distance
exports.nearItems = function(req, res) {
    var miles = req.params.miles;

    var userLng = req.user.latlng.latitude;
    var userLat = req.user.latlng.longitude;


    var userCoord = [userLng, userLat]

    Item.find({lnglat:
       {$near: userCoord,
        $maxDistance:miles/69.17}
    }).exec(function(err, items){
        console.log(err, items);
        res.jsonp(items);
    });
};


/**
 * List of all items
 */

exports.all = function(req, res) {
    if (req.query.itemRadius) {
        var miles = req.query.itemRadius;
        var userLng = req.user.lnglat[0];
        var userLat = req.user.lnglat[1];
        var userCoord = [userLng, userLat]

        Item.find({lnglat:
           {$near: userCoord,
            $maxDistance:miles/69.17}
        }).exec(function(err, items){
            console.log(err, items);
            res.jsonp(items);
        });
    }
    else if (req.query.wantedItemsUserId) {
        console.log("Hi, sind wir da?")
        var wantedByUser = req.query.wantedItemsUserId;
        Item.find({wanted_by: wantedByUser}, function (err, items) {
                if (err) {
                    res.render('error', {
                        status: 500
                    });
                } else {
                    console.log("Yeah, im sending this back", items )
                    res.jsonp(items);
                }
        })
    }

    else {
    Item.find().sort('-created').populate('owned_by', 'name.first name.last username _id').exec(function(err, items) {
        if (err) {
            res.render('error', {
                status: 500
            });
        } else {
            res.jsonp(items);
        }
    });
    };
};


//Do not show items that are expired.
exports.notShowExpired = function(req, res) {
    var today = Date.now()

    var existingItems = [];
    Item.find({}, function(err, allItems){
        for (var i = 0; i < allItems.length; i ++) {
            if (allItems[i].startTime + 1000*3600*allItems[i].duration < today) {
                existingItems.push(allItems[i]);
            }
        }
        res.jsonp(existingItems);
    });
};

// //Show wanted items
exports.showWantedItems = function(req, res) {
    var userID = req.user._id;
    Item.find({ status: "wanted", wanted_by: userID }, function(err, wantItems){
        res.jsonp(wantItems);
    });
};


// Change status of item when wanted by a user
exports.wantItem = function(req, res) {
    var itemID = req.item;
    var userID = req.user._id;

    Item.findByIdAndUpdate(itemId, { status: "wanted", wanted_by: userID }, function(err, items){
        res.redirect('/home');
    });
};

// Email to buyer and seller
exports.email = function(req, res) {
    // Email to Buyer
    // Item.find({_id: req.item._id}).populate("owned_by").exec(function(err, selectedItem){
        mailer.smtpTransport.sendMail({
        from: "PleaseTakeIt <pleasetakeitapp@gmail.com>", // sender address.  Must be the same as authenticated user if using Gmail.
        to: req.user.email, // BUYER EMAIL
        subject: "Item Purchased",
        generateTextFromHTML: true,
        html: "<p>Hi, " +
        req.user.username + // BUYER USERNAME
        ". You have purchased " +
        req.item._id +
        ". Please contact " +
        req.user.username + // Seller name
        " at " +
        req.user.email + // Seller EMAIL
        " for more details such as an agreed time and date of pickup. Also, please remind the owner to confirm pickup after you have recieved the item otherwise your deposit will be donated to charity."
        }, function(error, response){
            if(error){
               console.log(error);
            }
            else {
               console.log("Message sent: " + response.message);
            }
           mailer.smtpTransport.close(); // shut down the connection pool, no more messages.  Comment this line out to continue sending emails.
        });
    // })

    // Email to Seller
    // Item.find({_id: req.item._id}).populate("owned_by").exec(function(err, selectedItem){
        mailer.smtpTransport.sendMail({
        from: "PleaseTakeIt <pleasetakeitapp@gmail.com>", // sender address.  Must be the same as authenticated user if using Gmail.
        to: req.user.email, // SELLER EMAIL
        subject: "Congrats, your item was purchased!",
        generateTextFromHTML: true,
        html: "<p>Hi, " +
        req.user.username + // SELLER USERNAME
        " has placed a $10 deposit on your item. Please complete the deal below!</p>" +
        "<a href='http://localhost:3000/deal/" + req.user.email + "'>Finish Deal</a><br>"
        }, function(error, response){
            if(error){
               console.log(error);
            }
            else {
               console.log("Message sent: " + response.message);
            }
           mailer.smtpTransport.close(); // shut down the connection pool, no more messages.  Comment this line out to continue sending emails.
        });
    // })
}

exports.dealConfirm = function(req, res) {
    res.render('/deal/:id');
}

//Deal Success so money goes back to buyer
exports.dealSuccess = function(req, res) {
    alert("PleaseTakeIt thanks you for confirming item pickup and hopes to see you again!")
    // Item.find({_id: req.item._id}).populate("wanted_by").exec(function(err, selectedItem){
        mailer.smtpTransport.sendMail({
        from: "PleaseTakeIt <pleasetakeitapp@gmail.com>",
        to: req.user.email, // receiver will be the BUYER EMIAL
        subject: "Item pickup confirmed",
        generateTextFromHTML: true,
        html: "<p>Hi, " +
        req.user.username + //BUYER USERNAME
        " we hope you enjoyed your experience with PleaseTakeIt and hope to see you soon."
        }, function(error, response){
            if(error){
               console.log(error);
            }
            else {
               console.log("Message sent: " + response.message);
            }
           mailer.smtpTransport.close(); // shut down the connection pool, no more messages.  Comment this line out to continue sending emails.
        });
    // })

    // =================== Balanced/STRIPE needs to give money back to buyer HERE.=====================
}

//Deal Failed so money goes to charity
exports.dealFail = function(req, res) {
    mailer.smtpTransport.sendMail({
    from: "PleaseTakeIt <pleasetakeitapp@gmail.com>",
    to: req.user.email, // receiver will be the BUYER EMIAL
    subject: "Item not picked up",
    generateTextFromHTML: true,
    html: "<p>Hi, " +
    req.user.username + //BUYER USERNAME
    ".<br>" +
    "Unfortunately, the owner of the item indicates that you have not picked up the item on the agreed date. As a result, your deposit will be donated to charity."
    }, function(error, response){
        if(error){
           console.log(error);
        }
        else {
           console.log("Message sent: " + response.message);
        }
       mailer.smtpTransport.close(); // shut down the connection pool, no more messages.  Comment this line out to continue sending emails.
    });
    // =================== Balanced/STRIPE needs to give money to donation..=====================
}
