#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');

const verdaccioBin = path.join(__dirname, 'node_modules', '.bin', 'verdaccio.cmd');
const publicDir = path.join(__dirname, 'public');
const configPath = path.join(__dirname, 'config.yaml');
const envFile = path.join(__dirname, '.env');
const htpasswdFile = path.join(__dirname, 'htpasswd');

// 默认用户信息
const DEFAULT_USER = {
  username: 'aily-admin',
  password: 'aily123456',
  email: 'admin@aily.local'
};

/**
 * 读取 .env 文件
 */
function loadEnv() {
  if (!fs.existsSync(envFile)) {
    return {};
  }
  const content = fs.readFileSync(envFile, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  return env;
}

/**
 * 保存用户信息到 .env 文件
 */
function saveEnv(userInfo) {
  const content = `# Verdaccio 用户信息 (自动生成)
NPM_USER=${userInfo.username}
NPM_PASS=${userInfo.password}
NPM_EMAIL=${userInfo.email}
NPM_REGISTRY=http://localhost:4873
`;
  fs.writeFileSync(envFile, content, 'utf8');
  console.log(`用户信息已保存到 ${envFile}`);
}

/**
 * 检查用户是否已存在
 */
function isUserExists() {
  if (!fs.existsSync(htpasswdFile)) {
    return false;
  }
  const content = fs.readFileSync(htpasswdFile, 'utf8');
  return content.includes(DEFAULT_USER.username + ':');
}

/**
 * 等待 verdaccio 启动
 */
function waitForVerdaccio(maxRetries = 30, interval = 1000) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    
    const check = () => {
      const req = http.get('http://localhost:4873/-/ping', (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      
      req.on('error', () => {
        retry();
      });
      
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    
    const retry = () => {
      retries++;
      if (retries >= maxRetries) {
        reject(new Error('Verdaccio 启动超时'));
      } else {
        setTimeout(check, interval);
      }
    };
    
    check();
  });
}

/**
 * 创建 npm 用户
 */
async function createNpmUser(userInfo) {
  console.log(`正在创建用户: ${userInfo.username}...`);
  
  try {
    // 使用 npm-cli-adduser 的方式，通过 HTTP API 创建用户
    const userData = {
      _id: `org.couchdb.user:${userInfo.username}`,
      name: userInfo.username,
      password: userInfo.password,
      email: userInfo.email,
      type: 'user',
      roles: [],
      date: new Date().toISOString()
    };
    
    const postData = JSON.stringify(userData);
    
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 4873,
        path: `/-/user/org.couchdb.user:${userInfo.username}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 201 || res.statusCode === 200) {
            console.log(`用户 ${userInfo.username} 创建成功`);
            // 解析返回的 token
            try {
              const result = JSON.parse(data);
              if (result.token) {
                userInfo.token = result.token;
              }
            } catch (e) {
              // 忽略解析错误
            }
            resolve(userInfo);
          } else if (res.statusCode === 409) {
            console.log(`用户 ${userInfo.username} 已存在`);
            resolve(userInfo);
          } else {
            reject(new Error(`创建用户失败: ${res.statusCode} - ${data}`));
          }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  } catch (error) {
    console.error('创建用户失败:', error.message);
    throw error;
  }
}

/**
 * 配置 npm registry 认证
 */
function configureNpmAuth(userInfo) {
  try {
    // 设置 registry
    execSync(`npm config set registry http://localhost:4873`, { stdio: 'inherit' });
    console.log('已配置 npm registry: http://localhost:4873');
  } catch (error) {
    console.error('配置 npm 失败:', error.message);
  }
}

/**
 * 首次启动时初始化用户
 */
async function initUser() {
  const env = loadEnv();
  
  // 检查是否已经有用户信息
  if (env.NPM_USER && env.NPM_PASS) {
    console.log(`使用已存在的用户: ${env.NPM_USER}`);
    return;
  }
  
  // 检查 htpasswd 文件中是否已有用户
  if (isUserExists()) {
    console.log(`用户 ${DEFAULT_USER.username} 已存在于 htpasswd 中`);
    saveEnv(DEFAULT_USER);
    return;
  }
  
  console.log('首次启动，等待 Verdaccio 就绪...');
  
  try {
    await waitForVerdaccio();
    console.log('Verdaccio 已就绪');
    
    // 创建用户
    const userInfo = await createNpmUser(DEFAULT_USER);
    
    // 保存到 .env
    saveEnv(userInfo);
    
    // 配置 npm
    configureNpmAuth(userInfo);
    
  } catch (error) {
    console.error('初始化用户失败:', error.message);
  }
}

// 启动 verdaccio
const child = spawn(verdaccioBin, ['--config', configPath], {
  stdio: 'inherit',
  shell: true
});

child.on('error', (err) => {
  console.error('Failed to start verdaccio:', err);
});

child.on('close', (code) => {
  console.log(`Verdaccio exited with code ${code}`);
});

// 首次启动时初始化用户
initUser().catch(err => {
  console.error('用户初始化失败:', err);
});

/**
 * 启动静态文件服务器
 */
function startStaticServer(port = 4874) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
  };

  const server = http.createServer((req, res) => {
    // 只允许 GET 方法
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // 解析 URL
    const parsedUrl = url.parse(req.url, true);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    
    // 默认访问 index.html
    if (pathname === '/') {
      pathname = '/index.html';
    }

    // 构建文件路径
    const filePath = path.join(publicDir, pathname);
    
    // 安全检查：防止目录遍历攻击
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // 检查文件是否存在
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // 获取文件扩展名和 MIME 类型
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      // 读取并返回文件
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });
  });

  server.listen(port, () => {
    console.log(`静态文件服务器已启动: http://localhost:${port}`);
    console.log(`服务目录: ${publicDir}`);
  });

  server.on('error', (err) => {
    console.error('静态文件服务器启动失败:', err.message);
  });

  return server;
}

// 启动静态文件服务器
startStaticServer(4874);
