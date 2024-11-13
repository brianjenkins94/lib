#!/bin/bash

CWD=$(pwd)

cd "$(dirname "$0")"

rm -rf demo/ monaco-vscode-api/

VERSION=10.1.4

if [[ "$(uname -s)" == MINGW* ]]; then
	git clone --depth=1 --branch v$VERSION https://github.com/CodinGame/monaco-vscode-api.git
else
	git clone --no-checkout --depth 1 --filter=tree:0 --sparse --branch v$VERSION https://github.com/CodinGame/monaco-vscode-api.git
	cd monaco-vscode-api/
	git sparse-checkout set --no-cone "!/*" "/demo"
	git checkout
    cd ..
fi

cp -rf monaco-vscode-api/demo/ .

rm -rf monaco-vscode-api/

cd demo/

if [[ "$(uname -s)" == Darwin* ]]; then
	sed -i "" "s/file:[^\"]*/^$VERSION/g" package.json
else
	sed -i "s/file:[^\"]*/^$VERSION/g" package.json
fi

npm pkg delete dependencies["@codingame/monaco-vscode-server"]
npm pkg delete dependencies["dockerode"]
npm pkg delete dependencies["express"]
npm pkg delete dependencies["ws"]

#npm pkg set overrides["@xterm/xterm"]="5.4.0-beta.20"

npm install jschardet @vscode/iconv-lite-umd vscode@npm:@codingame/monaco-vscode-api@$VERSION monaco-editor@npm:@codingame/monaco-vscode-editor-api@$VERSION

cd "$CWD"
