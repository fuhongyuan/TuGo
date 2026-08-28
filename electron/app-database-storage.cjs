const { mkdir, readFile, writeFile, access, rename, copyFile, readdir, unlink } = require('fs/promises')
const { join } = require('path')

/**
 * Owns durable App SQLite bytes: atomic snapshots, bounded backups and the
 * two recovery entry points. SQL schema and business CRUD remain in the App
 * Repository/IPC layer, so this module is safe to exercise independently of
 * Electron windows and Runtime processes.
 */
class AppDatabaseStorage {
  constructor({ userDataPath, databasePath, backupDirectory, pendingRecoveryPath, log }) {
    this.userDataPath = userDataPath
    this.databasePath = databasePath
    this.backupDirectory = backupDirectory
    this.pendingRecoveryPath = pendingRecoveryPath
    this.log = log || (async () => {})
    this.persistQueue = Promise.resolve()
    this.persistSequence = 0
    this.lastBackupAt = 0
  }

  async backup(force = false) {
    const current = Date.now()
    if (!force && current - this.lastBackupAt < 60_000) return
    try { await access(this.databasePath) } catch { return }
    await mkdir(this.backupDirectory, { recursive: true })
    const stamp = new Date(current).toISOString().replace(/[:.]/g, '-')
    const path = join(this.backupDirectory, `tugo-${stamp}.sqlite`)
    await copyFile(this.databasePath, path)
    this.lastBackupAt = current
    const files = (await readdir(this.backupDirectory)).filter(name => /^tugo-.*\.sqlite$/.test(name)).sort().reverse()
    await Promise.all(files.slice(12).map(name => unlink(join(this.backupDirectory, name)).catch(() => undefined)))
    return { path, name: `tugo-${stamp}.sqlite` }
  }

  persist(database) {
    const snapshot = Buffer.from(database.export())
    database.run('PRAGMA foreign_keys=ON')
    const write = this.persistQueue.catch(error => this.log(`previous database save failed: ${String(error?.stack || error)}`)).then(() => this.writeSnapshot(snapshot))
    this.persistQueue = write
    return write
  }

  async writeSnapshot(snapshot) {
    await mkdir(this.userDataPath, { recursive: true })
    await this.backup()
    const temporaryPath = `${this.databasePath}.tmp-${process.pid}-${++this.persistSequence}`
    await writeFile(temporaryPath, snapshot, { flush: true })
    try { await rename(temporaryPath, this.databasePath) }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
      await unlink(this.databasePath).catch(() => undefined)
      await rename(temporaryPath, this.databasePath)
    }
  }

  async open(SQL) {
    let bytes = await this.applyPendingRecovery(SQL)
    if (!bytes) try { bytes = await readFile(this.databasePath) } catch { /* first launch */ }
    if (bytes?.length) {
      try { this.assertHealthy(new SQL.Database(bytes)) }
      catch (primaryError) {
        await this.log(`primary app database failed integrity check: ${String(primaryError?.stack || primaryError)}`)
        const recovered = await this.findHealthyBackup(SQL)
        if (!recovered) throw primaryError
        bytes = recovered.bytes
        await copyFile(recovered.path, this.databasePath)
        await this.log(`app database recovered automatically from ${recovered.name}`)
      }
    }
    return bytes?.length ? new SQL.Database(bytes) : new SQL.Database()
  }

  assertHealthy(database, requireProjects = false) {
    try {
      const integrity = database.exec('PRAGMA integrity_check')?.[0]?.values?.[0]?.[0]
      const projectCount = Number(database.exec('SELECT COUNT(*) FROM projects')?.[0]?.values?.[0]?.[0] || 0)
      if (integrity !== 'ok' || (requireProjects && projectCount < 1)) throw new Error(`integrity=${integrity} projects=${projectCount}`)
      return projectCount
    } finally { database.close() }
  }

  async applyPendingRecovery(SQL) {
    try {
      const bytes = await readFile(this.pendingRecoveryPath)
      const projects = this.assertHealthy(new SQL.Database(bytes), true)
      await this.backup(true)
      const temporaryPath = `${this.databasePath}.recovery-${process.pid}`
      await writeFile(temporaryPath, bytes, { flush: true })
      await rename(temporaryPath, this.databasePath)
      await rename(this.pendingRecoveryPath, `${this.pendingRecoveryPath}.applied-${Date.now()}`)
      await this.log(`database recovery applied source=${this.pendingRecoveryPath} projects=${projects}`)
      return bytes
    } catch (error) {
      if (error?.code !== 'ENOENT') await this.log(`pending database recovery skipped: ${String(error?.stack || error)}`)
      return null
    }
  }

  async findHealthyBackup(SQL) {
    const names = (await readdir(this.backupDirectory).catch(() => [])).filter(name => /^tugo-.*\.sqlite$/.test(name)).sort().reverse()
    for (const name of names) try {
      const path = join(this.backupDirectory, name); const bytes = await readFile(path)
      this.assertHealthy(new SQL.Database(bytes))
      return { name, path, bytes }
    } catch { /* Try older backup. */ }
    return null
  }
}

module.exports = { AppDatabaseStorage }
