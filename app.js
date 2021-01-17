require('dotenv').config()
const express = require('express')
const { ShareServiceClient, StorageSharedKeyCredential } = require('@azure/storage-file-share')
const Redis = require('ioredis')
const axios = require('axios')

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

async function saveGlyphToCache(buf, path) {
	const data = {
		created: Date.now(),
		base64: buf.toString('base64')
	}
	await redis.hset('glyphcache', path, JSON.stringify(data))
}

async function readGlyphFromCache(path) {
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

async function readNameFromCache(uuid) {
	const json = await redis.hget('namecache', uuid)
	if(json == null) {
		return null
	}

	const data = JSON.parse(json)
	if(data.created < Date.now() - process.env.NAME_CACHE_TTL) {
		return null
	}
	return data.name
}

async function saveNameToCache(name, uuid) {
	const data = {
		created: Date.now(),
		name: name
	}
	await redis.hset('namecache', uuid, JSON.stringify(data))
}

async function getGlyph(fileName) {
	const cachedGlyph = await readGlyphFromCache(fileName)
	if(cachedGlyph != null) {
		return cachedGlyph
	}
	const downloadedGlyph = await getFileFromShare('glyphs', fileName)
	if(process.env.DEBUG_MODE) {
		console.log('Downloaded glyph ' + fileName)
	}
	await saveGlyphToCache(downloadedGlyph, fileName)
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

let mojangRequestsPast10Minutes = 0
setInterval(() => {
	mojangRequestsPast10Minutes = 0
}, 600000)

app.get('/name/:uuid', async (req, res) => {
	if(!req.params.uuid || (req.params.uuid.length !== 32 && req.params.uuid.length !== 36)) {
		res.sendStatus(400)
	}
	const cachedName = await readNameFromCache(req.params.uuid)
	if(cachedName || cachedName === '') {
		res.send(cachedName)
		return
	}

	if(mojangRequestsPast10Minutes > 550) {
		res.sendStatus(500)
		return
	}
	console.log('Requesting Mojang API for user ' + req.params.uuid)

	try {
		mojangRequestsPast10Minutes++
		const names = await axios.get(`https://api.mojang.com/user/profiles/${req.params.uuid}/names`)
		let name
		if(res.status === 200) {
			name = names.data[names.data.length-1].name
		} else {
			name = ''
			console.warn('Non-200 response received for name request. Received: ' + res.status)
		}

		res.contentType('text/plain')
		res.send(name)
		await saveNameToCache(name, req.params.uuid)
	} catch(e) {
		console.error(e)
		res.sendStatus(e.status)
		await saveNameToCache('', req.params.uuid)
	}
})

redis.on('connect', () => {
	app.listen(80, () => {
		console.log('Listening on port 80')
	})
})

