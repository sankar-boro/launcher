#!/usr/bin/env bash

rm -rf ./launcher.log && \
rm -rf /home/sankar/.data && \
DATA_DIR=/home/sankar/.data \
node ./dist/index.js spawn \
--provider native ./configs/data/humidefi.json

# sudo lsof -i -P -n | grep LISTEN