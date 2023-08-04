#!/usr/bin/env bash

# rm -rf $HOME/launcher.log && \
# rm -rf $HOME/.data && \
# DATA_DIR=$HOME/.data \
# nohup node ./dist/index.js spawn \
# --provider native ./configs/data/humidefi.json &> launcher.log &

rm -rf ./launcher.log && \
rm -rf ./tmp && \
DATA_DIR=./tmp \
nohup node ./dist/index.js spawn \
--provider native ./configs/data/humidefi.json &> launcher.log &

# sudo lsof -i -P -n | grep LISTEN