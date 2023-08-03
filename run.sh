#!/usr/bin/env bash

rm -rf $HOME/launcher.log && \
rm -rf $HOME/.data && \
DATA_DIR=$HOME/.data \
node ./dist/index.js spawn \
--provider native ./configs/data/humidefi.json

# sudo lsof -i -P -n | grep LISTEN