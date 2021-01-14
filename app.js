require('dotenv').config()
const express = require('express')
const { ShareServiceClient, StorageSharedKeyCredential } = require('@azure/storage-file-share')
const Redis = require('ioredis')

const redis = new Redis(6379, process.env.REDIS_HOST)

async function getFileFromShare(shareName, fileName) {
	const account = process.env.AZURE_ACCOUNT_NAME || ''
	const accountKey = process.env.AZURE_ACCOUNT_KEY || ''
	const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey)
	const serviceClient = new ShareServiceClient(
		`https://${account}.file.core.windows.net`,
		sharedKeyCredential
	)
	const directoryClient = serviceClient.getShareClient(shareName).getDirectoryClient('')
	const fileClient = directoryClient.getFileClient(fileName)
	return await fileClient.downloadToBuffer()
}

async function saveToCache(buf, path) {
	const data = {
		created: Date.now(),
		base64: buf.toString('base64')
	}
	await redis.hset('glyphcache', path, JSON.stringify(data))
}

async function readFromCache(path) {
	const json = await redis.hget('glyphcache', path)
	if(json == null) {
		return null
	}

	const data = JSON.parse(json)
	if(data.created < Date.now() - process.env.GLYPH_CACHE_TTL) {
		return null
	}

	return Buffer.from(data.base64, 'base64')
}

async function getGlyph(fileName) {
	const cachedGlyph = await readFromCache(fileName)
	if(cachedGlyph != null) {
		return cachedGlyph
	}
	const downloadedGlyph = await getFileFromShare('glyphs', fileName)
	if(process.env.DEBUG_MODE) {
		console.log('Downloaded glyph ' + fileName)
	}
	await saveToCache(downloadedGlyph, fileName)
	return downloadedGlyph
}

const app = express()
app.get('/glyph/:img', async (req, res) => {
	res.contentType('image/png')
	try {
		res.send(await getGlyph(req.params.img))
	} catch(e) {
		if(e.statusCode === 404) {
			res.sendStatus(404)
		} else {
			res.sendStatus(500)
			console.error(e)
		}
	}
})

redis.on('connect', () => {
	app.listen(80, () => {
		console.log('Listening on port 80')
	})
})

