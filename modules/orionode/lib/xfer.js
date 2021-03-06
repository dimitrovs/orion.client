/*******************************************************************************
 * Copyright (c) 2016, 2017 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 *
 * Contributors:
 * IBM Corporation - initial API and implementation
 *******************************************************************************/
/*eslint-env node */
var api = require('./api'),
	archiver = require('archiver'),
	request = require('request'),
	express = require('express'),
	path = require('path'),
	os = require('os'),
//Busboy = require('busboy'),
	Promise = require('bluebird'),
	mkdirp = require('mkdirp'),
	fs = Promise.promisifyAll(require('fs-extra')),
	fileUtil = require('./fileUtil'),
	log4js = require('log4js'),
	logger = log4js.getLogger("xfer"),
	yauzl = require("yauzl"),
	responseTime = require('response-time');

var writeError = api.writeError, 
	writeResponse = api.writeResponse;
	
function getUploadsFolder(options) {
	if (options) {
		return path.join(options.configParams['orion.single.user'] ? 
			path.join(os.homedir(), ".orion") : options.workspaceDir, ".uploads");
	}
	return path.join(os.homedir(), ".orion");
}

var UPLOADS_FOLDER;
var fileRoot;

function checkUserAccess(req, res, next){
	var uri = (typeof req.contextPath === "string" && req.originalUrl.substring(req.contextPath.length)) || req.originalUrl;
	// import/export rights depend on access to the file content
	if (uri.startsWith("/xfer/export/") && uri.endsWith(".zip")){
		uri = "/file/" + uri.substring("/xfer/export/".length, uri.length - 4) + '/';
	} else if (uri.startsWith("/xfer/import/")) {
		uri = "/file/" + uri.substring("/xfer/import/".length); //$NON-NLS-1$
		if (!uri.endsWith("/")) //$NON-NLS-1$
			uri += '/';
	}	
	req.user.checkRights(req.user.username, uri, req, res, next);
}

/**
 * @callback
 */
module.exports.router = function(options) {
	fileRoot = options.fileRoot;
	if (!fileRoot) { throw new Error('options.fileRoot is required'); }
	module.exports.write = write;
	module.exports.getUploadDir = getUploadDir;
	
	UPLOADS_FOLDER = getUploadsFolder(options);
	
	mkdirp(UPLOADS_FOLDER, function (err) {
		if (err) logger.error(err);
	});

	return express.Router()
	.use(responseTime({digits: 2, header: "X-Xfer-Response-Time", suffix: true}))
	.use(checkUserAccess)
	.get('/export*', getXfer)
	.post('/import*', postImportXfer);
};

module.exports.getXferFrom = getXferFrom;
module.exports.postImportXferTo = postImportXferTo;

function getOptions(req, res) {
	var opts = req.get("X-Xfer-Options");
	if(typeof opts !== 'string') {
		return [];
	}
	return opts.split(",");
}
	
function reportTransferFailure(res, err) {
	var message = "File transfer failed";
	if (err.message) {
		message += ": " + err.message;
	}
	return writeResponse(400, res, null, {
				Severity: "Error",
				HttpCode: 400,
				Code: 0,
				Message: message,
				DetailedMessage: message
	});
}

function postImportXfer(req, res) {
	var rest = req.params["0"];
	var file = fileUtil.getFile(req, rest);
	postImportXferTo(req, res, file);
}

function postImportXferTo(req, res, file) {
	var xferOptions = getOptions(req, res);
	if (xferOptions.indexOf("sftp") !== -1) {
		return writeError(500, res, "Not implemented yet.");
	}
	var sourceURL = req.query.source;
	var shouldUnzip = xferOptions.indexOf("raw") === -1;
	var fileName = req.get("Slug");
	if (!fileName) {
		if (sourceURL) {
			fileName = path.basename(sourceURL);
		}
	}
	if (!fileName) {
		return writeError(400, res, "Transfer request must indicate target filename");
	}
	function upload(request) {
		var tempFile = path.join(UPLOADS_FOLDER, Date.now() + fileName);
		var ws = fs.createWriteStream(tempFile);
		ws.on('error', function(err) {
			reportTransferFailure(res, err);
		});
		ws.on('finish', function() {
			completeTransfer(req, res, tempFile, file, fileName, xferOptions, shouldUnzip);
		});
		request.pipe(ws);
	}
	var length = -1;
	if (!sourceURL) {
		var lengthStr = req.get("X-Xfer-Content-Length") || req.get("Content-Length");
		if (lengthStr) length = Number(lengthStr);
	} else {
		var rerr,
			newreq = request(sourceURL, {}, function(err, res) {
				rerr = err;
		})
		if(rerr) {
			return writeError(400, res, rerr.message);
		}
		return upload(newreq);
	}
	if (req.get("Content-Type") === "application/octet-stream") {
		upload(req);
		return;
	}
	writeError(500, res, "Not implemented yet.");
//	var busboy = new Busboy({ headers: req.headers });
//	busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
//		console.log('File [' + fieldname + ']: filename: ' + filename + ', encoding: ' + encoding + ', mimetype: ' + mimetype);
//		file.on('data', function(data) {
//			console.log('File [' + fieldname + '] got ' + data.length + ' bytes');
//		});
//		file.on('end', function() {
//			console.log('File [' + fieldname + '] Finished');
//		});
//	});
//	busboy.on('finish', function() {
//		console.log('Done parsing form!');
// 		api.setResponseNoCache(res);
//		res.writeHead(303, { Connection: 'close', Location: '/' });
//		res.end();
//	});
//	req.pipe(busboy);
}

function excluded(excludes, rootName, outputName) {
	if (rootName === outputName) {
		return false;
	}
	if (excludes.indexOf(path.basename(outputName)) !== -1) {
		return true;
	}
	return excluded(excludes, rootName, path.dirname(outputName));
}

function completeTransfer(req, res, tempFile, file, fileName, xferOptions, shouldUnzip) {
	var overwrite = xferOptions.indexOf("overwrite-older") !== -1;
	function overrideError(files) {
		writeResponse(400, res, null, {
			Severity: "Error",
			HttpCode:400,
			Code: 0,
			Message: "Failed to transfer all files to " + file.path.substring(file.workspaceDir.length) + 
				", the following files could not be overwritten: " + files.join(","),
			JsonData: {
				ExistingFiles: files
			}
		});
	}
	if (shouldUnzip) {
		var excludes = (req.query.exclude || "").split(",");
		if (fs.existsSync(path.join(file.path, ".git"))) {
			excludes.push(".git");
		}
		var failed = [];
		yauzl.open(tempFile, {
			lazyEntries: true,
			validateEntrySizes: true
		}, function(err, zipfile) {
			if (err) {
				return writeError(400, res, err.message);
			}
			zipfile.readEntry();
			zipfile.on("close", function() {
				fs.unlink(tempFile, function(exp){});
				if (res) {
					if (failed.length) {
						return overrideError(failed);
					}
					res.setHeader("Location", api.join(fileRoot, file.workspaceId, file.path.substring(file.workspaceDir.length+1)));
					writeResponse(201, res);
					res = null;
				}
			});
			zipfile.on("error",function(err){
				if (res) {
					return writeError(400, res, "Failed during file unzip: " + err.message);
				}
			});
			zipfile.on("entry", function(entry) {
				var entryName = entry.fileName;
				var outputName = path.join(file.path, entryName);
				if (!excluded(excludes, file.path, outputName)) {
					if (/\/$/.test(entry.fileName)) {
						if (!fs.existsSync(outputName)) {
							mkdirp.sync(outputName);	
						}
						zipfile.readEntry();
					}else {
						if (!overwrite && fs.existsSync(outputName) || entry.isEncrypted()) {
							failed.push(entryName);
							zipfile.readEntry();
							return;
						}
						// make sure all sub folders exist
						var subfolderPath = path.join(file.path, path.dirname(entryName));
						if (!fs.existsSync(subfolderPath)) {
							mkdirp.sync(subfolderPath);
						}
						var writeStream = fs.createWriteStream(outputName);
						zipfile.openReadStream(entry, {decompress: entry.isCompressed() ? true : null}, function(err, readStream) {
							if (err) throw err;
							readStream.on("end", function() {
								zipfile.readEntry();
							});
							readStream.pipe(writeStream);
						});
						writeStream.on('error', function(err) {
							if (res) {
								reportTransferFailure(res, err);
								res = null;
							}
						});
					}
				}else{
					zipfile.readEntry();
				}
				return;
			});
		});
	} else {
		var newFile = path.join(file.path, fileName);
		if (!overwrite && fs.existsSync(newFile)) {
			return overrideError([fileName]);
		}
		fs.move(tempFile, newFile, function(err) {
			if (err) {
				return writeError(400, res, "Transfer failed");
			}
			res.setHeader("Location", api.join(fileRoot, file.workspaceId, file.path.substring(file.workspaceDir.length+1)));
			writeResponse(201, res);
		});
	}
}
	
function getXfer(req, res) {
	var rest = req.params["0"];
	var file = fileUtil.getFile(req, rest);
	
	if (path.extname(file.path) !== ".zip") {
		return writeError(400, res, "Export is not a zip");
	}
	
	getXferFrom(req, res, file);
}

function getXferFrom(req, res, file) {
	var filePath = file.path.replace(/.zip$/, "");
	var zip = archiver('zip');
	zip.pipe(res);
	write(zip, filePath, filePath)
	.then(function() {
		zip.finalize();
	})
	.catch(function(err) {
		if (err.code === "ENOENT") {
			// bug 511513, use a custom message so that the server's workspace path isn't leaked
			writeError(404, res, "Folder '" + filePath.substring(file.workspaceDir.length + 1) + "' does not exist");
		} else {
			writeError(500, res, err.message);
		}
	});
}

function write (zip, base, filePath) {
	return fs.statAsync(filePath)
	.then(function(stats) {
		/*eslint consistent-return:0*/
		if (stats.isDirectory()) {
			if (filePath.substring(filePath.length-1) !== "/") filePath = filePath + "/";
			return fs.readdirAsync(filePath)
			.then(function(directoryFiles) {
				var SUBDIR_SEARCH_CONCURRENCY = 10;
				return Promise.map(directoryFiles, function(entry) {
					return write(zip, base, filePath + entry);
				},{ concurrency: SUBDIR_SEARCH_CONCURRENCY});
			});
		}
		zip.file(filePath, { name: filePath.substring(base.length).replace(/\\/g, "/") });
	});
}
function getUploadDir(){
	return UPLOADS_FOLDER;
}
