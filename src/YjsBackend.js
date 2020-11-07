const { encode } = require("isomorphic-textencoder");
const diff = require('fast-diff')

const path = require("./path.js");
const { EEXIST, ENOENT, ENOTDIR, ENOTEMPTY } = require("./errors.js");

const TYPE = 't';
const MTIME = 'm';
const MODE = 'o';
const CONTENT = 'c';
const PARENT = 'p';
const PREVPARENT = '-p';
const BASENAME = 'b';
const PREVBASENAME = '-b';

function ID (client, clock) {
  this.client = client;
  this.clock = clock;
}

function serializeID (id) {
  const buffer = new ArrayBuffer(16);
  const dataview = new DataView(buffer);
  dataview.setFloat64(0, id.client);
  dataview.setFloat64(8, id.clock);
  return new Uint8Array(buffer);
}

function parseID (arr) {
  if (!arr) return arr;
  const dataview = new DataView(arr.buffer);
  return new ID(dataview.getFloat64(0), dataview.getFloat64(8));
}

function sameID (id1, id2) {
  return id1.client === id2.client && id1.clock === id2.clock;
}

module.exports = class YjsBackend {
  constructor(Y, ydoc, find) {
    this.Y = Y;
    this._ydoc = ydoc;
    this._find = find;
    this._inodes = this._ydoc.getArray('!inodes');
    if (this._inodes.length === 0) {
      const rootdir = new this.Y.Map();
      const mtimeMs = Date.now();
      const mode = 0o777;

      rootdir.set(MODE, mode);
      rootdir.set(TYPE, 'dir');
      rootdir.set(MTIME, mtimeMs);
      rootdir.set(CONTENT, true);

      rootdir.set(PARENT, null);
      rootdir.set(BASENAME, '/');
      this._inodes.push([rootdir]);
    }
  }
  get activated () {
    return true
  }
  _getInode(id) {
    const item = this._find(this._ydoc.store, id)
    const node = item.content.type;
    return node;
  }
  _childrenOf(id) {
    const children = [];
    for (const value of this._inodes) {
      const parent = parseID(value.get(PARENT))
      if (parent && sameID(parent, id) && value.get(CONTENT)) children.push(value);
    }
    return children;
  }
  _findChild(id, basename) {
    for (const value of this._inodes) {
      const parent = parseID(value.get(PARENT))
      if (parent && sameID(parent, id) && value.get(BASENAME) === basename && value.get(CONTENT)) return value;
    }
    return;
  }
  _lookup(filepath, follow = true) {
    let dir = this._inodes.get(0);
    if (filepath === '/') return dir;
    let partialPath = '/'
    let parts = path.split(filepath)
    // TODO: Actually, given we can reconstruct paths from the bottom up,
    // it might be faster to search by matching against the basepath and then
    // narrowing that set. The problem would be dealing with symlinks.
    for (let i = 1; i < parts.length; ++ i) {
      let part = parts[i];
      dir = this._findChild(dir._item.id, part);
      if (!dir) throw new ENOENT(filepath);
      // Follow symlinks
      if (follow || i < parts.length - 1) {
        if (dir.get(TYPE) === 'symlink') {
          let target = path.resolve(partialPath, dir.get(CONTENT))
          dir = this._lookup(target)
        }
        if (!partialPath) {
          partialPath = part
        } else {
          partialPath = path.join(partialPath, part)
        }
      }
    }
    return dir;
  }
  mkdir(filepath, { mode }) {
    if (filepath === "/") throw new EEXIST();
    let dir = this._lookup(path.dirname(filepath));
    let basename = path.basename(filepath);
    for (const child of this._childrenOf(dir._item.id)) {
      if (child.get(BASENAME) === basename) {
        throw new EEXIST();
      }
    }
    const mtimeMs = Date.now();
    this._ydoc.transact(() => {
      let node = new this.Y.Map()
      node.set(MODE, mode);
      node.set(TYPE, 'dir');
      node.set(MTIME, mtimeMs);
      node.set(CONTENT, true); // must be truthy or else directory is in a "deleted" state

      node.set(PARENT, serializeID(dir._item.id));
      node.set(BASENAME, basename);
      this._inodes.push([node]);
    }, 'mkdir');
  }
  rmdir(filepath) {
    let dir = this._lookup(filepath);
    if (dir.get(TYPE) !== 'dir') throw new ENOTDIR();
    const ino = dir._item.id;
    // check it's empty
    if (this._childrenOf(ino).length > 0) throw new ENOTEMPTY();
    // delete inode
    this._ydoc.transact(() => {
      dir.set(CONTENT, false);
    }, 'rmdir');
  }
  readdir(filepath) {
    let dir = this._lookup(filepath);
    if (dir.get(TYPE) !== 'dir') throw new ENOTDIR();
    return this._childrenOf(dir._item.id).map(node => node.get(BASENAME));
  }
  writeStat(filepath, size, { mode }) {
    let node
    try {
      node = this._lookup(filepath);
      if (mode == null) {
        mode = node.get(MODE);
      }
    } catch (err) {}
    if (mode == null) {
      mode = 0o666;
    }
    let dir = this._lookup(path.dirname(filepath));
    let parentId = dir._item.id;
    let basename = path.basename(filepath);
    const mtimeMs = Date.now();

    this._ydoc.transact(() => {
      if (!node) {
        node = new this.Y.Map();
        node.set(MODE, mode);
        node.set(TYPE, 'file');
        node.set(MTIME, mtimeMs);
        node.set(CONTENT, true); // set to truthy so file isn't in a "deleted" state

        node.set(PARENT, serializeID(parentId));
        node.set(BASENAME, basename);
        this._inodes.push([node]);
      } else {
        node.set(MODE, mode);
        node.set(TYPE, 'file');
        node.set(MTIME, mtimeMs);
      }
    }, 'writeFile');
    const stat = this.stat(filepath);
    return stat;
  }
  unlink(filepath) {
    let node = this._lookup(filepath, false);
    // delete inode
    this._ydoc.transact(() => {
      node.set(CONTENT, false);
    }, 'unlink');
  }
  rename(oldFilepath, newFilepath) {
    // Note: do both lookups before making any changes
    // so if lookup throws, we don't lose data (issue #23)
    // grab references
    let node = this._lookup(oldFilepath);
    let destDir = this._lookup(path.dirname(newFilepath));
    // Update parent
    this._ydoc.transact(() => {
      const parent = parseID(node.get(PARENT));
      const newParent = destDir._item.id
      if (!sameID(parent, newParent)) {
        node.set(PARENT, serializeID(newParent));
        const prevParent = parseID(node.get(PREVPARENT));
        if (!sameID(prevParent, parent)) {
          node.set(PREVPARENT, node.get(PARENT));
        }
      }

      const basename = node.get(BASENAME);
      const newBasename = path.basename(newFilepath);
      if (basename !== newBasename) {
        node.set(BASENAME, newBasename);
        if (node.get(PREVBASENAME) !== basename) {
          node.set(PREVBASENAME, basename);
        }
      }
    }, 'rename');
  }
  stat(filepath) {
    const node = this._lookup(filepath);
    const stat = {
      mode: node.get(MODE),
      type: node.get(TYPE),
      size: this._size(node),
      mtimeMs: node.get(MTIME),
      ino: node._item.id,
    };
    return stat;
  }
  lstat(filepath) {
    const node = this._lookup(filepath, false);
    const stat = {
      mode: node.get(MODE),
      type: node.get(TYPE),
      size: this._size(node),
      mtimeMs: node.get(MTIME),
      ino: node._item.id,
    };
    return stat;
  }
  readlink(filepath) {
    return this._lookup(filepath, false).get(CONTENT);
  }
  symlink(target, filepath) {
    let mode, node;
    try {
      node = this._lookup(filepath);
      if (mode === null) {
        mode = node.get(MODE);
      }
    } catch (err) {}
    if (mode == null) {
      mode = 0o120000;
    }
    let dir = this._lookup(path.dirname(filepath));
    let parentId = dir._item.id;
    let basename = path.basename(filepath);
    const mtimeMs = Date.now();

    this._ydoc.transact(() => {
      if (!node) {
        node = new this.Y.Map();
        node.set(MODE, mode);
        node.set(TYPE, 'symlink');
        node.set(MTIME, mtimeMs);
        node.set(CONTENT, target);

        node.set(PARENT, serializeID(parentId));
        node.set(BASENAME, basename);
        this._inodes.push([node]);
      } else {
        node.set(MODE, mode);
        node.set(TYPE, 'symlink');
        node.set(MTIME, mtimeMs);
      }
    }, 'symlink');
    const stat = this.lstat(filepath);
    return stat;
  }
  _du (dir) {
    let size = 0;
    const type = dir.get(TYPE)
    if (type === 'file') {
      size += this._size(dir);
    } else if (type === 'dir') {
      for (const entry of this._childrenOf(dir._item.id)) {
        size += this._du(entry);
      }
    }
    return size;
  }
  du (filepath) {
    let dir = this._lookup(filepath);
    return this._du(dir);
  }
  openYType(filepath) {
    let node = this._lookup(filepath, false);
    let data = node.get(CONTENT)
    if (data instanceof this.Y.AbstractType) {
      return data;
    }
  }

  saveSuperblock(superblock) {
    return
  }
  loadSuperblock() {
    return
  }
  readFileInode(inode) {
    let data = this._getInode(inode).get(CONTENT);
    if (data.constructor && data instanceof this.Y.Text) {
      data = encode(data.toString());
    }
    return data;
  }
  writeFileInode(inode, data, rawdata) {
    if (typeof rawdata === 'string') {
      // Update existing Text
      const oldData = this._getInode(inode).get(CONTENT);
      if (oldData && oldData instanceof this.Y.Text) {
        const oldString = oldData.toString();
        const changes = diff(oldString, rawdata);
        let idx = 0;
        for (const [kind, string] of changes) {
          switch (kind) {
            case diff.EQUAL: {
              idx += string.length;
              break;
            }
            case diff.DELETE: {
              oldData.delete(idx, string.length)
              break;
            }
            case diff.INSERT: {
              oldData.insert(idx, string);
              idx += string.length;
              break;
            }
          }
        }
        return;
      } else {
        // Use new Y.Text
        data = new this.Y.Text();
        data.insert(0, rawdata);
      }
    } else if (rawdata instanceof this.Y.AbstractType) {
      data = rawdata;
    } else {
      // Yjs will fail if data.constructor !== Uint8Array
      if (data.constructor.name === 'Buffer') {
        data = new Uint8Array(data.buffer);
      }
    }
    this._getInode(inode).set(CONTENT, data);
    return;
  }
  unlinkInode(inode) {
    return this._getInode(inode).set(CONTENT, false);
  }
  wipe() {
    return // TODO
  }
  close() {
    return
  }

  _size(node) {
    if (node.get(TYPE) !== 'file') return 0;

    const content = node.get(CONTENT);

    if (content instanceof this.Y.Text || typeof content === 'string') {
      return content.length;
    } else if (content instanceof Uint8Array) {
      return content.byteLength;
    } else {
      return 0;
    }
  }
}
