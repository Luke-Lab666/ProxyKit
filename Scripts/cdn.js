const isQuanX = typeof $task !== 'undefined'
const StatusText = isQuanX ? 'HTTP/1.1 302 Redirect' : 302
const CDN_HOST = 'git.apad.pro'

function rewrite(url) {
    const match = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)/)
    if (!match) return null

    const [, user, repo, branch, path] = match
    return `https://${CDN_HOST}/https://raw.githubusercontent.com/${user}/${repo}/${branch}/${path}`
}

const cdnUrl = rewrite($request.url)

if (cdnUrl) {
    const response = {
        status: StatusText,
        headers: {
            Location: cdnUrl
        }
    }
    $done(isQuanX ? response : { response })
} else {
    $done({})
}