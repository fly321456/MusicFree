# MusicFree 网易云音乐插件开发指南

本文档详细介绍了如何开发一个功能完整的 MusicFree 网易云音乐插件。下面这个表格汇总了实现插件功能需要完成的核心模块，你可以对照了解每个部分的作用。

| 插件功能模块 | 核心职责 | 关键实现要点 |
|------------|---------|------------|
| 基础信息 (platform, version) | 定义插件身份，供MusicFree识别和管理 | 平台标识platform必须唯一且准确，例如网易云音乐 |
| 搜索功能 (search) | 响应播放器的搜索请求，返回歌曲/专辑/歌手列表 | 需处理不同媒体类型（music, album, artist, sheet）的搜索逻辑和分页 |
| 播放源获取 (getMediaSource) | 解析并返回歌曲的真实可播放音频文件地址 | 需处理不同音质（如low, standard, high, super），并设置正确的请求头（如User-Agent, Referer）以避免反爬 |
| 歌单导入 (importMusicSheet) | 通过歌单链接，批量获取歌单内所有歌曲信息 | 需从链接中提取歌单ID，调用平台API获取详情，并将数据转换为标准格式 |
| 榜单支持 (getTopLists) | 提供平台各类音乐榜单的列表和详情 | 实现getTopLists（榜单列表）和getTopListDetail（榜单歌曲详情）两个接口 |

## 🔧 搭建插件基础结构

首先，创建一个JavaScript文件（例如 `index.js`），并导出插件的基本对象结构。这是插件与MusicFree客户端进行通信的基石。

```javascript
module.exports = {
  platform: "网易云音乐", // 插件名称，必须在MusicFree中唯一
  version: "1.0.0",
  author: "MusicFree Plugin",
  appVersion: ">=0.8.0", // 指定兼容的MusicFree版本
  description: "网易云音乐插件，支持搜索、播放、歌单导入和榜单功能",

  // 定义插件支持的搜索类型
  supportedSearchType: ['music', 'album', 'artist', 'sheet'],

  // 缓存控制策略，根据音源稳定性选择 'cache' / 'no-cache' / 'no-store'
  cacheControl: 'cache', 

  // 提示信息，指导用户如何使用歌单导入等功能
  hints: {
    importMusicSheet: [
      "网易云移动端：APP点击分享，然后复制链接",
      "网易云H5/PC端：复制URL，或者直接输入歌单ID即可",
      "默认歌单无法导入，先新建一个空白歌单复制过去再导入新歌单即可"
    ]
  }
};
```

## 🛠️ 工具函数实现

在实现核心功能之前，我们需要一些工具函数来辅助处理数据。

### 请求重试机制

网络请求可能会失败，实现重试机制可以提高插件的稳定性：

```javascript
// 请求重试函数
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return await response.json();
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        // 等待后重试，指数退避
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
  throw lastError;
}
```

### 数据标准化函数

网易云音乐API返回的数据格式需要转换为MusicFree标准格式。特别注意：
- **duration**: 网易云返回的是毫秒，需要转换为秒
- **id**: 需要确保是字符串类型

```javascript
// 将歌曲数据标准化
function normalizeMusicItem(song) {
  // duration 需要转换为秒（网易云返回的是毫秒）
  const duration = song.dt || song.duration || 0;
  const durationInSeconds = typeof duration === 'number' ? Math.floor(duration / 1000) : 0;
  
  return {
    id: String(song.id || ''), // 确保 id 是字符串类型
    title: song.name || song.title || '未知歌曲',
    artist: (song.ar || song.artists || []).map(artist => artist.name).join('/') || '未知艺术家',
    album: (song.al || song.album)?.name || '未知专辑',
    duration: durationInSeconds, // 转换为秒
    artwork: (song.al || song.album)?.picUrl || (song.al || song.album)?.pic || '',
    platform: '网易云音乐'
  };
}
```

### 歌单ID解析函数

从各种格式的链接中提取歌单ID：

```javascript
// 解析歌单ID
function parsePlaylistId(urlLike) {
  if (!urlLike) return null;
  
  const regexes = [
    /music\.163\.com.*playlist\?id=(\d+)/,
    /music\.163\.com.*playlist\/(\d+)/,
    /playlist\?id=(\d+)/,
    /playlist\/(\d+)/
  ];
  
  for (const regex of regexes) {
    const match = urlLike.match(regex);
    if (match) return match[1];
  }
  
  // 如果输入的不是链接，则认为是直接输入的歌单ID
  if (/^\d+$/.test(urlLike.trim())) {
    return urlLike.trim();
  }
  
  return null;
}
```

## 🔍 实现搜索功能

搜索是插件的核心功能。你需要处理用户输入的查询词、页码和搜索类型（歌曲、专辑等）。

```javascript
async search(query, page, type) {
  try {
    // 1. 根据不同类型构造请求参数
    const searchTypeMap = {
      'music': 1,     // 单曲
      'album': 10,    // 专辑
      'artist': 100,  // 歌手
      'sheet': 1000   // 歌单
    };

    const searchType = searchTypeMap[type] || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    // 使用重试机制发送请求
    const response = await fetchWithRetry('https://music.163.com/api/cloudsearch/pc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/'
      },
      body: JSON.stringify({
        s: query,       // 搜索关键词
        type: searchType, // 搜索类型
        limit: limit,      // 每页数量
        offset: offset // 偏移量
      })
    });

    const result = response.result || {};
    
    // 2. 将平台返回的数据标准化为MusicFree可识别的格式
    if (type === 'music') {
      const songs = result.songs || [];
      const songCount = result.songCount || 0;
      
      return {
        isEnd: songCount <= (page * limit), // 判断是否最后一页
        data: songs.map(song => normalizeMusicItem(song))
      };
    } else if (type === 'album') {
      const albums = result.albums || [];
      const albumCount = result.albumCount || 0;
      
      return {
        isEnd: albumCount <= (page * limit),
        data: albums.map(album => ({
          id: String(album.id || ''),
          title: album.name || '未知专辑',
          artist: (album.artist || {}).name || '未知艺术家',
          artwork: album.picUrl || album.pic || '',
          description: album.description || '',
          platform: '网易云音乐'
        }))
      };
    } else if (type === 'artist') {
      const artists = result.artists || [];
      const artistCount = result.artistCount || 0;
      
      return {
        isEnd: artistCount <= (page * limit),
        data: artists.map(artist => ({
          id: String(artist.id || ''),
          name: artist.name || '未知艺术家',
          avatar: artist.picUrl || artist.pic || '',
          description: artist.briefDesc || '',
          platform: '网易云音乐'
        }))
      };
    } else if (type === 'sheet') {
      const playlists = result.playlists || [];
      const playlistCount = result.playlistCount || 0;
      
      return {
        isEnd: playlistCount <= (page * limit),
        data: playlists.map(playlist => ({
          id: String(playlist.id || ''),
          title: playlist.name || '未知歌单',
          description: playlist.description || '',
          coverImg: playlist.coverImgUrl || playlist.picUrl || '',
          playCount: playlist.playCount || 0,
          platform: '网易云音乐'
        }))
      };
    }

    return {
      isEnd: true,
      data: []
    };
  } catch (error) {
    console.error('搜索失败:', error);
    return {
      isEnd: true,
      data: []
    };
  }
}
```

## 📻 获取音频播放地址

此函数根据歌曲信息获取真实的音频流地址，这是实现播放的关键一步。实现时采用了**三级降级策略**，确保最大程度获取到可用的音频URL：

1. **方案1（优先）**：使用网易云新API端点 `/api/song/url/v1`
2. **方案2（降级）**：使用网易云旧API端点 `/api/song/enhance/player/url`
3. **方案3（备选）**：使用第三方代理服务 `https://share.duanx.cn/url/wy/{songId}`

```javascript
async getMediaSource(musicItem, quality) {
  try {
    if (!musicItem || !musicItem.id) {
      throw new Error('无效的音乐项');
    }

    const songId = String(musicItem.id);
    
    // 音质映射：网易云使用 br 参数，128000=standard, 192000=high, 320000=super
    const qualityMap = {
      'low': 128000,
      'standard': 128000,
      'high': 192000,
      'super': 320000
    };
    
    const br = qualityMap[quality] || qualityMap['standard'];
    
    let audioUrl = null;
    
    // 方案1: 优先使用新的API端点
    try {
      const response = await fetchWithRetry(
        `https://music.163.com/api/song/url/v1?id=${songId}&level=exhigh&encodeType=mp3`,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://music.163.com/'
          }
        }
      );

      if (response.data && response.data.length > 0) {
        audioUrl = response.data[0].url;
      }
    } catch (error) {
      console.log('新API调用失败，尝试旧API:', error.message);
    }
    
    // 方案2: 如果新API失败，尝试旧API
    if (!audioUrl) {
      try {
        const oldResponse = await fetchWithRetry(
          `https://music.163.com/api/song/enhance/player/url?ids=[${songId}]&br=${br}`,
          {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://music.163.com/'
            }
          }
        );
        
        if (oldResponse.data && oldResponse.data.length > 0) {
          audioUrl = oldResponse.data[0].url;
        }
      } catch (error) {
        console.log('旧API调用失败，尝试代理服务:', error.message);
      }
    }

    // 方案3: 如果所有直接API都失败，使用代理服务作为备选方案
    if (!audioUrl) {
      try {
        // 代理服务URL格式：https://share.duanx.cn/url/wy/{songId}
        // 该服务会返回实际的音频URL或进行重定向到音频流
        const proxyUrl = `https://share.duanx.cn/url/wy/${songId}`;
        
        // 尝试获取代理服务返回的实际URL
        const proxyCheck = await fetch(proxyUrl, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://music.163.com/'
          },
          redirect: 'follow'
        });
        
        if (proxyCheck.ok) {
          // 如果HEAD请求成功，使用代理URL（代理服务会处理重定向）
          audioUrl = proxyUrl;
        } else {
          // 如果HEAD失败，尝试GET请求
          const proxyResponse = await fetch(proxyUrl, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://music.163.com/'
            },
            redirect: 'follow'
          });
          
          if (proxyResponse.ok) {
            const contentType = proxyResponse.headers.get('content-type') || '';
            // 如果是音频流，使用最终URL；否则使用代理URL
            if (contentType.includes('audio') || contentType.includes('stream')) {
              audioUrl = proxyResponse.url;
            } else {
              // 尝试解析JSON响应
              try {
                const text = await proxyResponse.text();
                const jsonData = JSON.parse(text);
                audioUrl = jsonData.url || jsonData.data?.url || proxyUrl;
              } catch {
                // 解析失败，使用代理URL
                audioUrl = proxyUrl;
              }
            }
          } else {
            // 即使响应不成功，也尝试使用代理URL（某些代理服务可能直接返回音频流）
            audioUrl = proxyUrl;
          }
        }
      } catch (error) {
        console.log('代理服务调用失败:', error.message);
        // 代理服务失败时，仍然尝试使用代理URL作为最后的尝试
        audioUrl = `https://share.duanx.cn/url/wy/${songId}`;
      }
    }

    if (!audioUrl) {
      throw new Error('无法获取音频链接，歌曲可能为VIP或暂无版权');
    }

    return {
      url: audioUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/'
      }
    };
  } catch (error) {
    console.error('获取媒体源失败:', error);
    return null;
  }
}
```

### 三级降级策略说明

1. **新API优先**：使用最新的网易云API，通常最稳定且音质最好
2. **旧API降级**：当新API不可用时，自动切换到旧版API
3. **代理服务备选**：当前两种方案都失败时，使用第三方代理服务作为最后的备选方案，提高成功率

**注意**：代理服务依赖于第三方服务的稳定性，如果代理服务不可用，可能会影响播放。建议优先使用官方API。

## 📜 实现歌单导入

歌单导入功能允许用户通过分享链接直接导入整个歌单，非常实用。

```javascript
async importMusicSheet(urlLike) {
  try {
    // 1. 从链接中解析出歌单ID
    const playlistId = parsePlaylistId(urlLike);
    if (!playlistId) {
      throw new Error("无效的歌单链接或ID");
    }

    // 2. 调用网易云API获取歌单详情
    const response = await fetchWithRetry(
      `https://music.163.com/api/playlist/detail?id=${playlistId}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/'
        }
      }
    );

    const playlist = response.playlist;
    if (!playlist) {
      throw new Error('歌单不存在或无法访问');
    }

    const tracks = playlist.tracks || [];
    if (tracks.length === 0) {
      return [];
    }

    // 3. 将歌单中的歌曲数据标准化
    return tracks.map(track => normalizeMusicItem(track));
  } catch (error) {
    console.error('导入歌单失败:', error);
    throw error;
  }
}
```

## 🏆 支持音乐榜单

音乐榜单是发现新歌的重要途径，实现此功能可以大大增强插件的实用性。

### 获取榜单列表

```javascript
async getTopLists() {
  try {
    const response = await fetchWithRetry(
      'https://music.163.com/api/toplist',
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/'
        }
      }
    );

    const list = response.list || [];
    
    return list.map(item => ({
      title: item.name || '未知榜单', // 榜单名称，如"飙升榜"、"新歌榜"
      data: (item.list || []).map(listItem => ({
        id: String(listItem.id || ''),
        title: listItem.name || listItem.title || '未知榜单',
        description: listItem.description || `更新频率：${listItem.updateFrequency || '未知'}`,
        coverImg: listItem.coverImgUrl || listItem.picUrl || '',
        playCount: listItem.playCount || 0,
        // 额外信息，用于后续获取详情
        extra: {
          source: 'netease',
          topId: String(listItem.id || '')
        },
        platform: '网易云音乐'
      }))
    }));
  } catch (error) {
    console.error('获取榜单列表失败:', error);
    return [];
  }
}
```

### 获取榜单详情

```javascript
async getTopListDetail(topListItem, page = 1) {
  try {
    const topId = String(topListItem.extra?.topId || topListItem.id || '');
    if (!topId) {
      throw new Error('无效的榜单ID');
    }

    const response = await fetchWithRetry(
      `https://music.163.com/api/toplist/detail?id=${topId}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/'
        }
      }
    );

    // 注意：榜单详情返回的数据结构是 response.playlist.tracks
    const playlist = response.playlist || {};
    const tracks = playlist.tracks || [];
    
    return {
      topListItem: topListItem,
      musicList: tracks.map(song => normalizeMusicItem(song)),
      isEnd: true // 榜单通常一次获取全部，无分页
    };
  } catch (error) {
    console.error('获取榜单详情失败:', error);
    return {
      topListItem: topListItem,
      musicList: [],
      isEnd: true
    };
  }
}
```

## 🐛 进行调试与发布

### 调试

在MusicFree的设置中开启开发日志（debug.devLog），可在插件代码中使用 `console.error()` 或 `console.log()` 来打印日志，帮助定位问题。

### 错误处理

建议实现重试机制。例如，网络请求失败时自动重试2-3次，使用指数退避策略。本插件已实现 `fetchWithRetry` 函数来处理网络请求的重试。

### 数据格式注意事项

1. **duration 单位转换**：网易云API返回的 `dt` 字段是毫秒，需要除以1000转换为秒
2. **id 类型统一**：确保所有 `id` 字段都是字符串类型，使用 `String()` 转换
3. **默认值处理**：为所有可能为空的字段提供默认值，避免显示异常

### 插件安装

开发完成后，在MusicFree的【插件设置】中选择【从本地文件安装】，然后导入你编写的JS文件即可。

## 📝 完整代码结构

完整的插件代码应该包含：

1. **工具函数**：请求重试、数据标准化、ID解析等
2. **插件配置**：platform、version、supportedSearchType 等
3. **核心功能**：search、getMediaSource、importMusicSheet、getTopLists、getTopListDetail

所有函数都应该包含完善的错误处理，确保插件在异常情况下不会崩溃。

希望这份指南能帮助你成功创建一个功能完整的网易云音乐插件。如果在开发过程中遇到更具体的问题，例如特定API的返回数据解析，可以再次提问，我会尽力提供更深入的信息。
