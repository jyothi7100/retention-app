const cds = require('@sap/cds')

cds.on('bootstrap', (app) => {
  // Only increase JSON body limit for the submitAttachment endpoint
  // Do NOT use app.use() globally as it breaks CAP's $batch parser
  const express = require('express')
  app.use('/odata/v4/retention/submitAttachment', 
    express.json({ limit: '50mb' })
  )
})

module.exports = cds.server