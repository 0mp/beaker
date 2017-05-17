import {BrowserWindow} from 'electron'
import {parse as parseURL} from 'url'
import pda from 'pauls-dat-api'
import * as datLibrary from '../networks/dat/library'
import * as archivesDb from '../dbs/archives'
import {DAT_HASH_REGEX, DEFAULT_DAT_API_TIMEOUT} from '../../lib/const'
import {showModal} from '../ui/modals'
import {showLocalPathDialog, validateLocalPath} from '../browser'
import {timer} from '../../lib/time'
import {PermissionsError, InvalidURLError, InvalidPathError} from 'beaker-error-constants'

// exported api
// =

const to = (opts) =>
  (opts && typeof opts.timeout !== 'undefined')
    ? opts.timeout
    : DEFAULT_DAT_API_TIMEOUT

export default {
  async status() {
    var status = {archives: 0, peers: 0}
    var archives = datLibrary.getActiveArchives()
    for (var k in archives) {
      status.archives++
      status.peers += archives[k].metadata.peers.length
    }
    return status
  },

  async create({title, description, createdBy}={}, {localPath} = {}) {
    // get origin info
    if (!createdBy) {
      createdBy = await datLibrary.generateCreatedBy(this.sender.getURL())
    } else if (typeof createdBy === 'string') {
      createdBy = await datLibrary.generateCreatedBy(createdBy)
    }

    if (!validateLocalPath(localPath).valid) {
      return new InvalidPathError('Cannot save the site to that folder')
    }

    // create the archive
    return datLibrary.createNewArchive({title, description, createdBy}, {localPath})
  },

  async fork(url, {title, description, createdBy} = {}, {localPath} = {}) {
    // get origin info
    if (!createdBy) {
      createdBy = await datLibrary.generateCreatedBy(this.sender.getURL())
    } else if (typeof createdBy === 'string') {
      createdBy = await datLibrary.generateCreatedBy(createdBy)
    }

    if (!validateLocalPath(localPath).valid) {
      return new InvalidPathError('Cannot save the site to that folder')
    }

    // create the archive
    return datLibrary.forkArchive(url, {title, description, createdBy}, {localPath})
  },

  async update(url, manifestInfo, {localPath} = {}) {
    var key = toKey(url)
    var archive = await datLibrary.getOrLoadArchive(key)

    if (localPath && !validateLocalPath(localPath).valid) {
      return new InvalidPathError('Cannot save the site to that folder')
    }

    if (!manifestInfo) {
      // show the update-info the modal
      let win = BrowserWindow.fromWebContents(this.sender)
      await assertSenderIsFocused(this.sender)
      let isReadOnly = !archive.writable
      return await showModal(win, 'create-archive', {
        url,
        isReadOnly,
        size: isReadOnly ? 'create-archive-readonly' : 'create-archive'
      })
    }

    // update manifest file
    var archiveInfo = await archivesDb.getMeta(key)
    var {title, description} = manifestInfo
    title = typeof title !== 'undefined' ? title : archiveInfo.title
    description = typeof description !== 'undefined' ? description : archiveInfo.description
    if (title !== archiveInfo.title || description !== archiveInfo.description) {
      await pda.updateManifest(archive.stagingFS, {title, description})
      await pda.commit(archive.stagingFS, {filter: manifestFilter})
      datLibrary.pullLatestArchiveMeta(archive)
    }

    // update settings
    if (localPath) {
      var userSettings = await archivesDb.setUserSettings(0, key, {localPath})
      await datLibrary.reconfigureStaging(archive, userSettings)
    }
  },

  async add(url, {localPath} = {}) {
    var key = toKey(url)

    // load localPath if needed
    if (!localPath) {
      try {
        let settings = await archivesDb.getUserSettings(0, key)
        localPath = settings.localPath
      } catch (e) {}
    }

    // prompt localPath if needed
    if (!localPath) {
      localPath = await showLocalPathDialog()
      if (!localPath) {
        throw new Error('Cancelled')
      }
    }

    if (!validateLocalPath(localPath).valid) {
      return new InvalidPathError('Cannot save the site to that folder')
    }

    // update settings
    var res = await archivesDb.setUserSettings(0, key, {isSaved: true, localPath})

    // pull metadata
    var archive = await datLibrary.getOrLoadArchive(key)
    datLibrary.pullLatestArchiveMeta(archive)
    return res
  },

  async remove(url) {
    var key = toKey(url)
    return archivesDb.setUserSettings(0, key, {isSaved: false})
  },

  async list(query={}) {
    return datLibrary.queryArchives(query)
  },

  async get(url, opts) {
    return timer(to(opts), async (checkin) => {
      var key = toKey(url)
      return datLibrary.getArchiveInfo(key)
    })
  },

  createEventStream() {
    return datLibrary.createEventStream()
  }
}

async function assertSenderIsFocused (sender) {
  if (!sender.isFocused()) {
    throw new UserDeniedError('Application must be focused to spawn a prompt')
  }
}

// helper to convert the given URL to a dat key
function toKey (url) {
  if (DAT_HASH_REGEX.test(url)) {
    // simple case: given the key
    return url
  } 
  
  var urlp = parseURL(url)

  // validate
  if (urlp.protocol !== 'dat:') {
    throw new InvalidURLError('URL must be a dat: scheme')
  }
  if (!DAT_HASH_REGEX.test(urlp.host)) {
    // TODO- support dns lookup?
    throw new InvalidURLError('Hostname is not a valid hash')
  }

  return urlp.host
}

function manifestFilter (path) {
  // only allow /dat.json
  return (path !== '/dat.json') // (true => dont handle)
}