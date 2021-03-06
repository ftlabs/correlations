require('dotenv').config({ silent : process.env.NODE_ENV === 'production'  });
const   debug = require('debug')('correlations:index');
const express = require('express');
const    path = require('path');
var    exphbs = require('express-handlebars');

const     app = express();

app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

const fetchContent = require('./bin/lib/fetchContent');
const    correlate = require('./bin/lib/correlate');
const         v1v2 = require('./bin/lib/v1v2');
const     memories = require('./bin/lib/memories');

const session = require('cookie-session');
const OktaMiddleware = require('@financial-times/okta-express-middleware');
const okta = new OktaMiddleware({
  client_id: process.env.OKTA_CLIENT,
  client_secret: process.env.OKTA_SECRET,
  issuer: process.env.OKTA_ISSUER,
  appBaseUrl: process.env.BASE_URL,
  scope: 'openid offline_access name'
});

app.use(session({
	secret: process.env.SESSION_TOKEN,
	maxAge: 24 * 3600 * 1000, //24h
	httpOnly: true
}));


var requestLogger = function(req, res, next) {
    debug("RECEIVED REQUEST:", req.method, req.url);
    next(); // Passing the request to the next handler in the stack.
}

app.use(requestLogger);

// these routes do *not* use OKTA

app.use('/static', express.static('static'));

const TOKEN = process.env.TOKEN;
if (! TOKEN ) {
  throw new Error('ERROR: TOKEN not specified in env');
}

app.get('/dummy', (req, res) => {
  res.json({ testing: "testing", 'one-two-three' : 'testing' });
});

function healthCheck1() {
  const summary          = correlate.summary()
  const summaryOfFetches = fetchContent.summariseFetchTimings();
  const ontologies = correlate.ontologies();
  const ontologiesString = ontologies.join(', ');

  return {
    id               : 1,
    name             : `check largest island exists and contains more than 1 of ${ontologiesString}`,
    ok               : ( summary.hasOwnProperty('counts')
                      && summary.counts.hasOwnProperty('largestIslandSize')
                      && summary.counts.largestIslandSize > 1 ),
    severity         : 1,
    businessImpact   : 'the FT Labs Google Home game, Make Connections, will be failing',
    technicalSummary : `Checks if the islands data structure has been properly populated with groups of correlated ${ontologiesString}`,
    panicGuide       : 'check the logs and /summaryOfFetches',
    checkOutput      : { summaryOfFetches },
    lastUpdated      : (summary && summary.times)? summary.times.intervalCoveredHrs : 'unknown',
  };
}

app.get('/__health', (req, res) => {
  const ontologies = correlate.ontologies();
  const label = ontologies.join('-');

  const stdResponse = {
    schemaVersion : 1,
    systemCode    : `ftlabs-correlations-${label}`,
    name          : `FT Labs Correlations ${label}`,
    description   : `uses SAPI+CAPI to build graph of correlations of ${ontologies.join('+')} mentioned in article metadata`,
    checks        : [],
  };

  stdResponse.checks.push( healthCheck1() );

	res.json( stdResponse );
});

app.get('/__gtg', (req, res) => {
  const check = healthCheck1();
  const status = (check.ok)? 200 : 503;
	res.status(status).end();
});


// these route *do* use OKTA
app.set('json spaces', 2);

// Check for valid OKTA login or valid token to byass OKTA login
// This function is not in a middleware or seperate file because
// it requires the context of okta and app.use to function
app.use((req, res, next) => {
  if ('token' in req.headers){
	   if(req.headers.token === process.env.TOKEN){
		     debug(`Token (header) was valid.`);
		     next();
       } else {
         debug(`The token (header) value passed was invalid.`);
         res.status(401);
         res.json({
           status : 'err',
           message : 'The token (header) value passed was invalid.'
         });
       }
  } else if('token' in req.query ){
    if(req.query.token === process.env.TOKEN){
      debug(`Token (query string) was valid.`);
		  next();
    } else {
      debug(`The token (query) value passed was invalid.`);
      res.status(401);
      res.json({
        status : 'err',
        message : 'The token (query) value passed was invalid.'
      });
    }
  } else {
    debug(`No token in header or query, so defaulting to OKTA`);
		// here to replicate multiple app.uses we have to do
		// some gross callback stuff. You might be able to
    // find a nicer way to do this

		// This is the equivalent of calling this:
		// app.use(okta.router);
		// app.use(okta.ensureAuthenticated());
    // app.use(okta.verifyJwts());

		okta.router(req, res, error => {
			if (error) {
				return next(error);
      }
			okta.ensureAuthenticated()(req, res, error => {
				if (error) {
					return next(error);
        }
				okta.verifyJwts()(req, res, next);
      });
    });
  }
});

function sortIsland( island ){
  // sort all the entities by count and then alphabetically,
  // assuming island = { e1: num1, e2: num2, ...}
  const entities = Object.keys(island).sort( (a,b) => {
    if(island[a] < island[b]){ return +1; }
    else if (island[a] > island[b]) { return -1; }
    else { // counts are equal, so sort alphabetically
      if(a > b) { return +1;}
      else if(a < b) { return -1;}
      else { return 0; }
     }
  });

  const sortedIsland = {};
  entities.map( entity => {
    sortedIsland[entity] = island[entity];
  });

  return {
    entities,
    sortedIsland
  }
}

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

app.get('/', (req, res) => {
  // find the biggest island
  const islands = correlate.allIslands();
  const island = (islands.length > 0)? islands[0] : [ {'entity1': 1, 'entity2' : 1}];
  const entities = sortIsland( island ).entities;

  debug( `/: island=${JSON.stringify(island, null, 2)},
  entities=${JSON.stringify(entities, null, 2)}`);

  res.render('home', {
    ontologies : correlate.ontologies().join('+'),
    entity1 : entities[0],
    entity2 : entities[1 + getRandomInt(entities.length -2)],
    entity1a : entities[1],
  });
});

app.get('/article/:uuid', (req, res) => {
	fetchContent.article(req.params.uuid)
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /article: ${err.message}` );
  })
});

app.get('/searchByUUID/:uuid', (req, res) => {
	fetchContent.searchByUUID(req.params.uuid)
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /searchByUUID: ${err.message}` );
  })
});

app.get('/searchLastSeconds/:seconds', (req, res) => {
	const interval = req.params.seconds;
	const nowSecs = Math.floor( Date.now() / 1000 );

	fetchContent.searchUnixTimeRange(nowSecs - interval, nowSecs)
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /searchLastSeconds: ${err.message}` );
  })
});

app.get('/searchLastSeconds/:seconds/:entity', (req, res) => {
	const interval = req.params.seconds;
  const   entity = req.params.entity;
	const  nowSecs = Math.floor( Date.now() / 1000 );

	fetchContent.searchUnixTimeRange(nowSecs - interval, nowSecs, {
    constraints: [entity],
    maxResults : 100,
  })
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /searchLastSeconds: ${err.message}` );
  })
});

app.get('/searchLastSeconds/:seconds/:entity1/:entity2', (req, res) => {
	const interval = req.params.seconds;
  const  entity1 = req.params.entity1;
  const  entity2 = req.params.entity2;
	const  nowSecs = Math.floor( Date.now() / 1000 );

	fetchContent.searchUnixTimeRange(nowSecs - interval, nowSecs, {
    constraints : [entity1, entity2],
     maxResults : 100,
  })
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /searchLastSeconds: ${err.message}` );
  })
});

app.get('/updateCorrelations', (req, res) => {
	correlate.fetchUpdateCorrelationsLatest()
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /updateCorrelations: ${err.message}` );
  })
  ;
});

app.get('/updateCorrelationsEarlier/:seconds', (req, res) => {
	correlate.fetchUpdateCorrelationsEarlier(req.params.seconds)
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /updateCorrelationsEarlier: ${err.message}` );
  })
;
});

app.get('/allCoocs', (req, res) => {
	res.json( correlate.allCoocs() );
});

app.get('/allData', (req, res) => {
	res.json( correlate.allData() );
});

app.get('/summary', (req, res) => {
	res.json( correlate.summary() );
});

app.get('/summaryOfFetches', (req, res) => {
	res.json( fetchContent.summariseFetchTimings() );
});
app.get('/summaryOfFetches/:history', (req, res) => {
	res.json( fetchContent.summariseFetchTimings(req.params.history) );
});

app.get('/allIslands', (req, res) => {
	res.json( correlate.allIslands() );
});

app.get('/biggestIsland', (req, res) => {
	res.json( correlate.biggestIsland() );
});

app.get('/allEntities', (req, res) => {
	res.json( correlate.allEntities() );
});

app.get('/allEntitiesWithPrefLabels', (req, res) => {
  correlate.allEntitiesWithPrefLabels()
	.then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /allEntitiesWithPrefLabels: ${err.message}` );
  })
});

app.get('/entityPrefLabels', (req, res) => {
  res.json( correlate.entityPrefLabels() );
});

app.get('/newlyAppearedEntities', (req, res) => {
	res.json( correlate.newlyAppearedEntities() );
});

app.get('/allEntitiesCountsPairs', (req, res) => {
	res.json( correlate.allEntitiesCountsPairs() );
});

app.get('/islandOf/:entity', (req, res) => {
  const entity = req.params.entity;
  const island = correlate.getIslandOfEntity(req.params.entity);
  const sortedIsland = sortIsland( island).sortedIsland;

	res.json( {
		entity,
		sortedIsland
	} );
});

app.get('/statsOfIslandOf/:entity', (req, res) => {
  const entity = req.params.entity;
  const statsOfIslandOf = correlate.getStatsOfIslandOfEntity(req.params.entity);

	res.json( {
		entity,
		statsOfIslandOf
	} );
});

app.get('/logbook', (req, res) => {
	res.json( correlate.logbook.reverse() );
});

app.get('/calcChainBetween/:entity1/:entity2', (req, res) => {
	res.json( correlate.calcChainBetween(req.params.entity1, req.params.entity2) );
});

app.get('/calcChainLengthsFrom/:entity', (req, res) => {
	res.json( correlate.calcChainLengthsFrom(req.params.entity) );
});

app.get('/calcChainWithArticlesBetween/:entity1/:entity2', (req, res) => {
	correlate.fetchCalcChainWithArticlesBetween(req.params.entity1, req.params.entity2)
  .then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /calcChainWithArticlesBetween: ${err.message}` );
  })
  ;
});

app.get('/calcSoNearliesOnMainIsland', (req, res) => {
	res.json( correlate.calcSoNearliesOnMainIsland() );
});

app.get('/soNearliesOnMainIslandByEntity', (req, res) => {
	res.json( correlate.soNearliesOnMainIslandByEntity() );
});

app.get('/calcMostBetweenSoNearliesOnMainIsland', (req, res) => {
	res.json( correlate.calcMostBetweenSoNearliesOnMainIsland() );
});

app.get('/calcMostBetweenSoNearliesOnMainIsland/:sortBy', (req, res) => {
	res.json( correlate.calcMostBetweenSoNearliesOnMainIsland(req.params.sortBy) );
});

app.get('/calcSoNearliesForEntities/:entities', (req, res) => {
  const entities = req.params.entities.split(',');
  const max = (req.query.max)? req.query.max : 10;
	res.json( correlate.calcSoNearliesForEntities(entities, max) );
});

app.get('/calcCoocsForEntities/:entities', (req, res) => {
  const entities = req.params.entities.split(',');
  const max = (req.query.max)? req.query.max : 10;
	res.json( correlate.calcCoocsForEntities(entities, max) );
});

app.get('/searchByEntityWithFacets/:entity', (req, res) => {
  const entity = req.params.entity;
	fetchContent.searchByEntityWithFacets(entity)
  .then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /searchByEntityWithFacets: ${err.message}` );
  })
  ;
});

app.get('/v1v2/entity/:entity', (req, res) => {
  const entity = req.params.entity;
	v1v2.fetchVariationsOfEntity(entity)
  .then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /v1v2/entity: ${err.message}` );
  })
  ;
});

app.get('/v1v2/store', (req, res) => {
  res.json( v1v2.store() );
});

app.get('/v1v2/store_errors', (req, res) => {
  res.json( v1v2.store_errors() );
});

app.get('/tmeIdToV2/:entity', (req, res) => {
  const entity = req.params.entity;
	fetchContent.tmeIdToV2(entity)
  .then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /tmeIdToV2: ${err.message}` );
  })
  ;
});

app.get('/v2ApiCall/', (req, res) => {
  const url = req.query.url;
	fetchContent.v2ApiCall(url)
  .then( obj => res.json( obj ) )
  .catch( err => {
    res.status(500).send( `ERROR: /v2ApiCall: ${err.message}` );
  })
  ;
});

app.get('/exhaustivelyPainfulDataConsistencyCheck', (req, res) => {
  correlate.exhaustivelyPainfulDataConsistencyCheck()
  .then( obj => {
    console.log( `INFO: exhaustivelyPainfulDataConsistencyCheck: response json: ${JSON.stringify(obj)}`);
    res.json( obj );
  })
  .catch( err => {
    res.status(500).send( `ERROR: /exhaustivelyPainfulDataConsistencyCheck: ${err.message}` );
  })
  ;
});

app.get('/calcOverlappingChains/:entities', (req, res) => {
  const entities = req.params.entities.split(',');
  try {
	   res.json( correlate.calcOverlappingChains(entities) );
   }
   catch( err ){
     res.json( {
       calling: '/calcOverlappingChains',
       err : err.message,
     });
   }
});

function expandFriend(f){
  const fPieces = f.split(':');
  const name = fPieces[1];
  const taxonomy = fPieces[0];
  const prefix = (taxonomy==='people')? '' : 'o:';
  const prefixName = `${prefix}${name}`;
  return {
    id : f,
    name: prefixName,
    nameNbsp : prefixName.replace(/ /,'&nbsp;'),
    taxonomy,
    url : `/calcChainLengthsFrom/${f}`,
  }
}

app.get('/calcOverlappingChains/display/:entities', (req, res) => {
  const entities = req.params.entities.split(',');
  try {
    const overlappingChains = correlate.calcOverlappingChains(entities);
    const friends = {
      shared : overlappingChains.overlaps.friends.shared.map( expandFriend ),
      unshared : {},
    };

    Object.keys(overlappingChains.overlaps.friends.unshared).map( entity => {
      friends.unshared[entity] = overlappingChains.overlaps.friends.unshared[entity].map( expandFriend )
    })

    const friendsOfFriends = {
      sharedViaUnsharedFriends : overlappingChains.overlaps.friendsOfFriends.sharedViaUnsharedFriends.map( expandFriend ),
      sharedViaSharedFriends : overlappingChains.overlaps.friendsOfFriends.sharedViaSharedFriends.map( expandFriend ),
      unshared : {}
    }

    Object.keys(overlappingChains.overlaps.friendsOfFriends.unshared).map( entity => {
      friendsOfFriends.unshared[entity] = overlappingChains.overlaps.friendsOfFriends.unshared[entity].map( expandFriend )
    })

    res.render('overlaps', {
      overlappingChains,
      entityPair : overlappingChains.entities.join(' and '),
      relationship : (overlappingChains.overlaps.areAlreadyFriends)? 'friends' : 'not friends',
      friends,
      friendsOfFriends,
      description : [
        "Two entities are considered 'friends' if they are cited in the same article, and 'friends of friends' if they are not directly friends but share another entity they are both cited with.",
        "E.g. Alan and Betty are cited in the same article so are considered 'friends', as are Betty and Chas who are both cited in a different article, but since Alan and Chas are never cited in the same article they are considered 'friends of friends', with Betty being the shared friend.",
        "In this view, we are looking at shared friends, and shared friends of friends, paying particular attention to the grouping in sharedViaUnsharedFriends.",
        "Entities in the 'unshared' columns are sorted by number of articles in which they are cited, most first.",
        "'Shared' means across *all* the specified entities, so if 2 of 3 entities share a friend and the 3rd doesn't, that friend counts as not shared."
      ].join('<br>'),
    });
   }
   catch( err ){
     res.json( {
       calling: '/calcOverlappingChains',
       err : err.message,
     });
   }
});

//---

function startListening(){
	app.listen(process.env.PORT, function(){
		console.log('INFO: Server is listening on port', process.env.PORT);
	});
}

function startup() {
  return Promise.resolve(1)
  .then( () => {
    const startupRangeSecs = (process.env.hasOwnProperty('STARTUP_RANGE_SECS'))? parseInt(process.env.STARTUP_RANGE_SECS) : 0;
    if (startupRangeSecs > 0) {
      console.log(`INFO: startup: startupRangeSecs=${startupRangeSecs}`);
    	return correlate.fetchUpdateCorrelationsEarlier(startupRangeSecs);
    } else {
      return { msg: 'startup: no data pre-loaded' };
    }
  })
  .catch( err => {
    throw new Error( `startup: err=${err}`);
  })
  .then( info => {
    startListening();
    return;
  })
  ;
}

// function forceGC() {
//   try {
//     if (global.gc) {global.gc();}
//   } catch (e) {
//     console.log("cannot request gc unless `node --expose-gc index.js`");
//     process.exit();
//   }
// }

const MAX_POSTSTARTUP_ITERATIONS = (process.env.MAX_POSTSTARTUP_ITERATIONS)? process.env.MAX_POSTSTARTUP_ITERATIONS : 1; // assume we *always* do at least one

function postStartup(iterationsRemaining=MAX_POSTSTARTUP_ITERATIONS) {
  if (iterationsRemaining <= 0) {
    return Promise.resolve(); // return a promise
  }

  // forceGC(); // just desparate at this stage

  const postStartupRangeSecs = (process.env.hasOwnProperty('POST_STARTUP_RANGE_SECS'))? parseInt(process.env.POST_STARTUP_RANGE_SECS) : 0;
  console.log(`INFO: postStartup: postStartupRangeSecs=${postStartupRangeSecs}, iterationsRemaining=${iterationsRemaining}`);
  let force=true;
  const memBefore = memories.areMadeOfThis();
  return correlate.fetchUpdateCorrelationsEarlier(postStartupRangeSecs, force)
  .then(summaryData => debug(`postStartup: iterationsRemaining=${iterationsRemaining}, summaryData=${JSON.stringify(summaryData)}`) )
  .then( () => {
    memories.areBeyondCompareAndLog( `postStartup: post iteration`, memBefore );
    if( iterationsRemaining > 0 ){
      return postStartup( iterationsRemaining -1 );
    } else {
      return Promise.resolve();
    }
  })
  .catch( err => {
    throw new Error( `postStartup: iterationsRemaining=${iterationsRemaining}, err=${err}`);
  })
  ;
}

function updateEverySoOften(count=0){
  let updateEverySecs = process.env.UPDATE_EVERY_SECS;
  let updateEveryMillis = ((updateEverySecs == '')? 0 : parseInt(updateEverySecs)) * 1000;
  if (updateEveryMillis > 0) {
    console.log(`INFO: updateEverySoOften: next update in ${updateEverySecs} secs.`);
    setTimeout(() => {
      console.log(`INFO: updateEverySoOften: count=${count}, UPDATE_EVERY_SECS=${updateEverySecs}`);
      const memBefore = memories.areMadeOfThis();
      return correlate.fetchUpdateCorrelationsLatest()
      .then(summaryData => debug(`updateEverySoOften: fetchUpdateCorrelationsLatest: ${JSON.stringify(summaryData)}`) )
      .then( () => memories.areBeyondCompareAndLog( `updateEverySoOften: ending iteration`, memBefore ) )
      .then( () => updateEverySoOften(count+1) )
      .catch( err => {
        console.log( `ERROR: correlate.updateEverySoOften: err.message=${err.message}`);
      })
      ;
    }, updateEveryMillis);
  }
}

//---

startup()
.then(() => postStartup()        )
.then(() => updateEverySoOften() )
.then(() => console.log('INFO: full startup completed.') )
.catch( err => {
  console.log(`ERROR: on startup: err=${err}`);
})
;
