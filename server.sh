#!/bin/bash
# remove --inspect when not using debugging 
node --inspect --env-file=.env server.js "$@"

