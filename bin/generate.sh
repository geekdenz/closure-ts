#!/bin/sh

BASEDIR=$(cd $(dirname $0)/..; pwd;)

find $BASEDIR/closure-library/closure/goog -type f -name '*.js'|grep -v _test|sort|
    grep -v /demos/|
    xargs $BASEDIR/bin/closurets.js
