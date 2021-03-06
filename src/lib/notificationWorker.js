'use strict'

const _ = require('lodash')
const co = require('co')
const EventEmitter = require('events').EventEmitter
const utils = require('./notificationUtils')
const NotificationScheduler = require('five-bells-shared').NotificationScheduler
const transferDictionary = require('five-bells-shared').TransferStateDictionary
const transferStates = transferDictionary.transferStates
const uuid4 = require('uuid4')
const JSONSigning = require('five-bells-shared').JSONSigning
const config = require('../services/config')
const getTransfer = require('../models/db/transfers').getTransfer
const isTransferFinalized = require('./transferUtils').isTransferFinalized
const getSubscription = require('../models/db/subscriptions').getSubscription
const convertToExternalTransfer = require('../models/converters/transfers')
  .convertToExternalTransfer
const getAffectedSubscriptions = require('../models/db/subscriptions')
  .getAffectedSubscriptions
const getMatchingNotification = require('../models/db/notifications')
  .getMatchingNotification
const notificationDAO = require('../models/db/notifications')
const getFulfillment = require('../models/db/fulfillments').getFulfillment
const convertToExternalFulfillment = require('../models/converters/fulfillments')
  .convertToExternalFulfillment

const privateKey = config.getIn(['keys', 'notification_sign', 'secret'])

function * findOrCreate (subscriptionID, transferID, options) {
  const result = yield getMatchingNotification(
    subscriptionID, transferID, options)
  if (result) {
    return result
  }
  const values = _.assign({}, options.defaults || {}, {
    subscription_id: subscriptionID,
    transfer_id: transferID
  })
  if (!values.id) {
    values.id = uuid4()
  }
  yield notificationDAO.insertNotification(values, options)
  return yield notificationDAO.getNotification(values.id, options)
}

class NotificationWorker extends EventEmitter {
  constructor (uri, log, config) {
    super()

    this.uri = uri
    this.log = log
    this.config = config

    this.scheduler = new NotificationScheduler({
      notificationDAO, log,
      processNotification: this.processNotification.bind(this)
    })
    this.signatureCache = {}
  }

  start () { this.scheduler.start() }
  stop () { this.scheduler.stop() }
  processNotificationQueue () { return this.scheduler.processQueue() }

  * queueNotifications (transfer, transaction) {
    const affectedAccounts = _([transfer.debits, transfer.credits])
      .flatten().pluck('account').value()
    affectedAccounts.push('*')

    // Prepare notification for websocket subscribers
    const notificationBody = {
      resource: convertToExternalTransfer(transfer)
    }

    // If the transfer is finalized, see if it was finalized by a fulfillment
    let fulfillment
    if (isTransferFinalized(transfer)) {
      fulfillment = yield getFulfillment(transfer.id, { transaction })

      if (fulfillment) {
        if (transfer.state === transferStates.TRANSFER_STATE_EXECUTED) {
          notificationBody.related_resources = {
            execution_condition_fulfillment:
              convertToExternalFulfillment(fulfillment)
          }
        } else if (transfer.state === transferStates.TRANSFER_STATE_REJECTED) {
          notificationBody.related_resources = {
            cancellation_condition_fulfillment:
              convertToExternalFulfillment(fulfillment)
          }
        }
      }
    }

    const affectedAccountUris = affectedAccounts.map((account) =>
      account === '*' ? account : this.uri.make('account', account))

    let subscriptions = yield getAffectedSubscriptions(affectedAccountUris,
      {transaction})

    if (!subscriptions) {
      return
    }

    // log.debug('notifying ' + subscription.owner + ' at ' +
    //   subscription.target)
    const self = this
    const notifications = yield subscriptions.map(function (subscription) {
      return findOrCreate(subscription.id, transfer.id, { transaction })
    })

    co(function * () {
      self.log.debug('emitting transfer-{' + affectedAccounts.join(',') + '}')
      for (let account of affectedAccounts) {
        self.emit('transfer-' + account, notificationBody)
      }

      // We will schedule an immediate attempt to send the notification for
      // performance in the good case.
      // Don't schedule the immediate attempt if the worker isn't active, though.
      if (!self.scheduler.isEnabled()) return

      yield notifications.map(function (notification, i) {
        return self.processNotificationWithInstances(notification, transfer, subscriptions[i], fulfillment)
      })
      // Schedule any retries.
      yield self.scheduler.scheduleProcessing()
    }).catch(function (err) {
      self.log.warn('immediate notification send failed ' + err.stack)
    })
  }

  * processNotification (notification) {
    const transfer = yield getTransfer(notification.transfer_id)
    const subscription = yield getSubscription(notification.subscription_id)
    const fulfillment = yield getFulfillment(transfer.id)
    yield this.processNotificationWithInstances(notification, transfer, subscription, fulfillment)
  }

  * processNotificationWithInstances (notification, transfer, subscription, fulfillment) {
    this.log.debug('sending notification to ' + subscription.target)
    const subscriptionURI = this.uri.make('subscription', subscription.id)
    const notificationBody = {
      id: subscriptionURI + '/notifications/' + notification.id,
      subscription: subscriptionURI,
      event: 'transfer.update',
      resource: convertToExternalTransfer(transfer)
    }
    if (fulfillment) {
      if (transfer.state === transferStates.TRANSFER_STATE_EXECUTED) {
        notificationBody.related_resources = {
          execution_condition_fulfillment:
            convertToExternalFulfillment(fulfillment)
        }
      } else if (transfer.state === transferStates.TRANSFER_STATE_REJECTED) {
        notificationBody.related_resources = {
          cancellation_condition_fulfillment:
            convertToExternalFulfillment(fulfillment)
        }
      }
    }
    // Sign notification
    const algorithm = 'CC' // Crypto-condition signatures
    let signedNotification
    if (this.signatureCache[notification.id]) {
      signedNotification = _.extend(notificationBody, { signature: this.signatureCache[notification.id] })
    } else {
      signedNotification = JSONSigning.sign(notificationBody, algorithm, privateKey)
      this.signatureCache[notification.id] = signedNotification.signature
    }
    let retry = true
    try {
      const result = yield utils.sendNotification(
        subscription.target, signedNotification, this.config)
      // Success!
      if (result.statusCode < 400) {
        retry = false
      } else {
        this.log.debug('remote error for notification ' + result.statusCode,
          JSON.stringify(result.body))
        this.log.debug(signedNotification)
      }
    } catch (err) {
      this.log.debug('notification send failed ' + err)
    }

    if (retry) {
      yield this.scheduler.retryNotification(notification)
    } else {
      delete this.signatureCache[notification.id]
      yield notificationDAO.deleteNotification(notification.id)
    }
  }
}

module.exports = NotificationWorker
